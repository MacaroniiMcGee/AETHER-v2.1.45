import React, { useState, useEffect } from 'react';
import { Cpu, Info, Zap, Lock, AlertCircle, Radio, Wifi } from 'lucide-react';

interface PinConfig {
  physical: number;
  gpio: number | null;
  name: string;
  type: 'gpio' | 'power' | 'ground' | 'reserved';
  purpose?: string;
  association?: string;
  category?: 'available' | 'hardware-reserved' | 'wiegand-reserved' | 'door-io' | 'system-io';
  details?: string;
}

interface GPIOPinoutDiagramProps {
  doors?: Array<{
    id: number;
    name: string;
    lock: { gpio: number; name: string };
    dps: { gpio: number; name: string };
    rexIn: { gpio: number; name: string };
    ios?: Array<{ gpio: number; name: string; type: string; direction: string }>;
  }>;
  inputs?: Array<{ id: number; gpio: number; name: string; type: string }>;
  outputs?: Array<{ id: number; gpio: number; name: string; type: string }>;
  controllerOutputs?: Array<{ id: number; gpio: number; name: string; type: string }>;
  wiegandReaders?: Array<{ id: string; name: string; d0: number; d1: number }>;
}

export const GPIOPinoutDiagram: React.FC<GPIOPinoutDiagramProps> = ({
  doors = [],
  inputs = [],
  outputs = [],
  controllerOutputs = [],
  wiegandReaders = []
}) => {
  const [hoveredPin, setHoveredPin] = useState<number | null>(null);
  const [showLegend, setShowLegend] = useState(true);

  // Raspberry Pi 40-pin GPIO layout
  const basePinout: PinConfig[] = [
    // Left column (odd pins)
    { physical: 1, gpio: null, name: '3V3 Power', type: 'power', category: 'available' },
    { physical: 3, gpio: 2, name: 'GPIO 2 (SDA)', type: 'reserved', purpose: 'I2C Data', category: 'hardware-reserved', association: 'NFC PN532' },
    { physical: 5, gpio: 3, name: 'GPIO 3 (SCL)', type: 'reserved', purpose: 'I2C Clock', category: 'hardware-reserved', association: 'NFC PN532' },
    { physical: 7, gpio: 4, name: 'GPIO 4 (GPCLK0)', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 9, gpio: null, name: 'Ground', type: 'ground', category: 'available' },
    { physical: 11, gpio: 17, name: 'GPIO 17', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 13, gpio: 27, name: 'GPIO 27', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 15, gpio: 22, name: 'GPIO 22', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 17, gpio: null, name: '3V3 Power', type: 'power', category: 'available' },
    { physical: 19, gpio: 10, name: 'GPIO 10 (MOSI)', type: 'reserved', purpose: 'SPI MOSI', category: 'hardware-reserved', association: 'RS485 HAT' },
    { physical: 21, gpio: 9, name: 'GPIO 9 (MISO)', type: 'reserved', purpose: 'SPI MISO', category: 'hardware-reserved', association: 'RS485 HAT' },
    { physical: 23, gpio: 11, name: 'GPIO 11 (SCLK)', type: 'reserved', purpose: 'SPI Clock', category: 'hardware-reserved', association: 'RS485 HAT' },
    { physical: 25, gpio: null, name: 'Ground', type: 'ground', category: 'available' },
    { physical: 27, gpio: 0, name: 'GPIO 0 (ID_SD)', type: 'reserved', purpose: 'EEPROM Data', category: 'hardware-reserved', association: 'HAT ID' },
    { physical: 29, gpio: 5, name: 'GPIO 5', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 31, gpio: 6, name: 'GPIO 6', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 33, gpio: 13, name: 'GPIO 13', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 35, gpio: 19, name: 'GPIO 19', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 37, gpio: 26, name: 'GPIO 26', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 39, gpio: null, name: 'Ground', type: 'ground', category: 'available' },

    // Right column (even pins)
    { physical: 2, gpio: null, name: '5V Power', type: 'power', category: 'available' },
    { physical: 4, gpio: null, name: '5V Power', type: 'power', category: 'available' },
    { physical: 6, gpio: null, name: 'Ground', type: 'ground', category: 'available' },
    { physical: 8, gpio: 14, name: 'GPIO 14 (TXD)', type: 'reserved', purpose: 'UART TX', category: 'hardware-reserved', association: 'Serial Console' },
    { physical: 10, gpio: 15, name: 'GPIO 15 (RXD)', type: 'reserved', purpose: 'UART RX', category: 'hardware-reserved', association: 'Serial Console' },
    { physical: 12, gpio: 18, name: 'GPIO 18', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 14, gpio: null, name: 'Ground', type: 'ground', category: 'available' },
    { physical: 16, gpio: 23, name: 'GPIO 23', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 18, gpio: 24, name: 'GPIO 24', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 20, gpio: null, name: 'Ground', type: 'ground', category: 'available' },
    { physical: 22, gpio: 25, name: 'GPIO 25', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 24, gpio: 8, name: 'GPIO 8 (CE0)', type: 'reserved', purpose: 'SPI CE0', category: 'hardware-reserved', association: 'RS485 HAT' },
    { physical: 26, gpio: 7, name: 'GPIO 7 (CE1)', type: 'reserved', purpose: 'SPI CE1', category: 'hardware-reserved', association: 'RS485 HAT' },
    { physical: 28, gpio: 1, name: 'GPIO 1 (ID_SC)', type: 'reserved', purpose: 'EEPROM Clock', category: 'hardware-reserved', association: 'HAT ID' },
    { physical: 30, gpio: null, name: 'Ground', type: 'ground', category: 'available' },
    { physical: 32, gpio: 12, name: 'GPIO 12', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 34, gpio: null, name: 'Ground', type: 'ground', category: 'available' },
    { physical: 36, gpio: 16, name: 'GPIO 16', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 38, gpio: 20, name: 'GPIO 20', type: 'gpio', purpose: 'General Purpose', category: 'available' },
    { physical: 40, gpio: 21, name: 'GPIO 21', type: 'gpio', purpose: 'General Purpose', category: 'available' },
  ];

  // Build pin configuration with associations
  const pinout: PinConfig[] = basePinout.map(pin => {
    if (pin.gpio === null) return pin;

    let updatedPin = { ...pin };

    // Check Wiegand associations
    const wiegandReader = wiegandReaders.find(r => r.d0 === pin.gpio || r.d1 === pin.gpio);
    if (wiegandReader) {
      const isD0 = wiegandReader.d0 === pin.gpio;
      updatedPin.category = 'wiegand-reserved';
      updatedPin.purpose = `Wiegand ${isD0 ? 'D0' : 'D1'}`;
      updatedPin.association = wiegandReader.name;
      updatedPin.details = `${isD0 ? 'Data 0 (Green)' : 'Data 1 (White)'} - ${wiegandReader.name}`;
      return updatedPin;
    }

    // Check door associations
    for (const door of doors) {
      if (door.lock.gpio === pin.gpio) {
        updatedPin.category = 'door-io';
        updatedPin.purpose = 'Door Lock Output';
        updatedPin.association = `${door.name} - ${door.lock.name}`;
        updatedPin.details = `Controls lock mechanism for ${door.name}`;
        return updatedPin;
      }
      if (door.dps.gpio === pin.gpio) {
        updatedPin.category = 'door-io';
        updatedPin.purpose = 'Door Position Input';
        updatedPin.association = `${door.name} - ${door.dps.name}`;
        updatedPin.details = `Monitors door open/closed state for ${door.name}`;
        return updatedPin;
      }
      if (door.rexIn.gpio === pin.gpio) {
        updatedPin.category = 'door-io';
        updatedPin.purpose = 'REX Input';
        updatedPin.association = `${door.name} - ${door.rexIn.name}`;
        updatedPin.details = `Request to Exit button for ${door.name}`;
        return updatedPin;
      }
      // Check custom IOs
      if (door.ios) {
        const io = door.ios.find(i => i.gpio === pin.gpio);
        if (io) {
          updatedPin.category = 'door-io';
          updatedPin.purpose = `${io.direction === 'input' ? 'Input' : 'Output'} - ${io.type}`;
          updatedPin.association = `${door.name} - ${io.name}`;
          updatedPin.details = `${io.direction === 'input' ? 'Monitors' : 'Controls'} ${io.name} for ${door.name}`;
          return updatedPin;
        }
      }
    }

    // Check system inputs
    const input = inputs.find(i => i.gpio === pin.gpio);
    if (input) {
      updatedPin.category = 'system-io';
      updatedPin.purpose = `System Input - ${input.type}`;
      updatedPin.association = input.name;
      updatedPin.details = `${input.type} sensor/switch - ${input.name}`;
      return updatedPin;
    }

    // Check system outputs
    const output = outputs.find(o => o.gpio === pin.gpio);
    if (output) {
      updatedPin.category = 'system-io';
      updatedPin.purpose = `System Output - ${output.type}`;
      updatedPin.association = output.name;
      updatedPin.details = `${output.type} control - ${output.name}`;
      return updatedPin;
    }

    // Check controller outputs
    const ctrlOutput = controllerOutputs.find(co => co.gpio === pin.gpio);
    if (ctrlOutput) {
      updatedPin.category = 'system-io';
      updatedPin.purpose = `Controller Output - ${ctrlOutput.type}`;
      updatedPin.association = ctrlOutput.name;
      updatedPin.details = `${ctrlOutput.type} control - ${ctrlOutput.name}`;
      return updatedPin;
    }

    return updatedPin;
  });

  const getPinColor = (pin: PinConfig): string => {
    if (pin.type === 'power') return 'from-red-600 to-red-700';
    if (pin.type === 'ground') return 'from-slate-700 to-slate-800';
    
    switch (pin.category) {
      case 'hardware-reserved': return 'from-orange-600 to-red-600';
      case 'wiegand-reserved': return 'from-purple-600 to-indigo-600';
      case 'door-io': return 'from-blue-600 to-cyan-600';
      case 'system-io': return 'from-green-600 to-emerald-600';
      default: return 'from-slate-600 to-slate-700';
    }
  };

  const getPinIcon = (pin: PinConfig) => {
    if (pin.type === 'power') return <Zap size={16} className="text-white" />;
    if (pin.type === 'ground') return <div className="w-4 h-0.5 bg-white" />;
    if (pin.category === 'hardware-reserved') return <AlertCircle size={16} className="text-white" />;
    if (pin.category === 'wiegand-reserved') return <Radio size={16} className="text-white" />;
    if (pin.category === 'door-io') return <Lock size={16} className="text-white" />;
    if (pin.category === 'system-io') return <Zap size={16} className="text-white" />;
    return <Cpu size={16} className="text-white" />;
  };

  const leftPins = pinout.filter(p => p.physical % 2 === 1).sort((a, b) => a.physical - b.physical);
  const rightPins = pinout.filter(p => p.physical % 2 === 0).sort((a, b) => a.physical - b.physical);

  const hoveredPinData = hoveredPin !== null ? pinout.find(p => p.physical === hoveredPin) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-indigo-900/30 to-purple-900/30 rounded-xl p-6 border border-indigo-700/50">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-2xl font-bold flex items-center gap-3">
              <Cpu className="w-8 h-8 text-indigo-400" />
              GPIO Pinout Diagram
            </h3>
            <p className="text-slate-400 mt-1">
              Raspberry Pi 40-pin GPIO header with current pin assignments
            </p>
          </div>
          <button
            onClick={() => setShowLegend(!showLegend)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg font-semibold text-white transition-all flex items-center gap-2"
          >
            <Info size={16} />
            {showLegend ? 'Hide' : 'Show'} Legend
          </button>
        </div>

        {/* Legend */}
        {showLegend && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mt-4 p-4 bg-slate-900/50 rounded-lg border border-slate-700">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-gradient-to-r from-red-600 to-red-700 flex items-center justify-center">
                <Zap size={14} className="text-white" />
              </div>
              <span className="text-xs font-semibold text-slate-300">Power</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-gradient-to-r from-slate-700 to-slate-800 flex items-center justify-center">
                <div className="w-3 h-0.5 bg-white" />
              </div>
              <span className="text-xs font-semibold text-slate-300">Ground</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-gradient-to-r from-orange-600 to-red-600 flex items-center justify-center">
                <AlertCircle size={14} className="text-white" />
              </div>
              <span className="text-xs font-semibold text-slate-300">HW Reserved</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-gradient-to-r from-purple-600 to-indigo-600 flex items-center justify-center">
                <Radio size={14} className="text-white" />
              </div>
              <span className="text-xs font-semibold text-slate-300">Wiegand</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-gradient-to-r from-blue-600 to-cyan-600 flex items-center justify-center">
                <Lock size={14} className="text-white" />
              </div>
              <span className="text-xs font-semibold text-slate-300">Door I/O</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded bg-gradient-to-r from-green-600 to-emerald-600 flex items-center justify-center">
                <Zap size={14} className="text-white" />
              </div>
              <span className="text-xs font-semibold text-slate-300">System I/O</span>
            </div>
          </div>
        )}
      </div>

      {/* Pinout Diagram */}
      <div className="bg-slate-900/50 rounded-xl p-6 border border-slate-700">
        <div className="flex justify-center">
          <div className="relative">
            {/* Board representation */}
            <div className="flex gap-2">
              {/* Left column */}
              <div className="space-y-2">
                {leftPins.map(pin => (
                  <div
                    key={pin.physical}
                    onMouseEnter={() => setHoveredPin(pin.physical)}
                    onMouseLeave={() => setHoveredPin(null)}
                    className={`w-16 h-10 rounded-lg bg-gradient-to-r ${getPinColor(pin)} flex items-center justify-center cursor-pointer transition-all transform hover:scale-110 hover:shadow-lg relative group`}
                  >
                    {getPinIcon(pin)}
                    <div className="absolute -left-20 top-1/2 transform -translate-y-1/2 text-xs font-mono text-slate-400 text-right w-16">
                      {pin.physical}
                    </div>
                  </div>
                ))}
              </div>

              {/* Center - Raspberry Pi label */}
              <div className="flex items-center justify-center px-4">
                <div className="writing-mode-vertical text-center">
                  <div className="bg-gradient-to-b from-green-600 to-green-700 px-4 py-8 rounded-lg">
                    <div className="transform rotate-180" style={{ writingMode: 'vertical-rl' }}>
                      <span className="text-white font-bold text-lg">RASPBERRY PI</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right column */}
              <div className="space-y-2">
                {rightPins.map(pin => (
                  <div
                    key={pin.physical}
                    onMouseEnter={() => setHoveredPin(pin.physical)}
                    onMouseLeave={() => setHoveredPin(null)}
                    className={`w-16 h-10 rounded-lg bg-gradient-to-r ${getPinColor(pin)} flex items-center justify-center cursor-pointer transition-all transform hover:scale-110 hover:shadow-lg relative group`}
                  >
                    {getPinIcon(pin)}
                    <div className="absolute -right-20 top-1/2 transform -translate-y-1/2 text-xs font-mono text-slate-400 w-16">
                      {pin.physical}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Pin numbering labels */}
            <div className="absolute -top-6 left-0 right-0 flex justify-between px-2">
              <span className="text-xs font-bold text-slate-500">ODD</span>
              <span className="text-xs font-bold text-slate-500">EVEN</span>
            </div>
          </div>
        </div>

        {/* Hover info card */}
        {hoveredPinData && (
          <div className="mt-6 p-6 bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl border-2 border-indigo-500/50 shadow-2xl">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-3xl font-bold text-white">Pin {hoveredPinData.physical}</span>
                  {hoveredPinData.gpio !== null && (
                    <span className="text-xl font-mono text-cyan-400">GPIO {hoveredPinData.gpio}</span>
                  )}
                </div>
                <div className="text-lg font-semibold text-slate-300">{hoveredPinData.name}</div>
              </div>
              <div className={`w-16 h-16 rounded-xl bg-gradient-to-br ${getPinColor(hoveredPinData)} flex items-center justify-center shadow-lg`}>
                {React.cloneElement(getPinIcon(hoveredPinData) as React.ReactElement, { 
                  size: 32 
                })}
              </div>
            </div>

            <div className="space-y-3">
              {hoveredPinData.purpose && (
                <div>
                  <div className="text-sm font-semibold text-slate-500 mb-1">Purpose</div>
                  <div className="text-base text-white font-semibold">{hoveredPinData.purpose}</div>
                </div>
              )}

              {hoveredPinData.association && (
                <div>
                  <div className="text-sm font-semibold text-slate-500 mb-1">Current Assignment</div>
                  <div className="text-base text-cyan-400 font-semibold">{hoveredPinData.association}</div>
                </div>
              )}

              {hoveredPinData.details && (
                <div>
                  <div className="text-sm font-semibold text-slate-500 mb-1">Details</div>
                  <div className="text-sm text-slate-300">{hoveredPinData.details}</div>
                </div>
              )}

              {/* Category badge */}
              <div className="pt-3 border-t border-slate-700">
                <span className={`inline-block px-3 py-1 rounded-full text-xs font-bold ${
                  hoveredPinData.category === 'hardware-reserved' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30' :
                  hoveredPinData.category === 'wiegand-reserved' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' :
                  hoveredPinData.category === 'door-io' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' :
                  hoveredPinData.category === 'system-io' ? 'bg-green-500/20 text-green-400 border border-green-500/30' :
                  hoveredPinData.type === 'power' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                  hoveredPinData.type === 'ground' ? 'bg-slate-500/20 text-slate-400 border border-slate-500/30' :
                  'bg-slate-500/20 text-slate-400 border border-slate-500/30'
                }`}>
                  {hoveredPinData.category === 'hardware-reserved' ? '⚠️ HARDWARE RESERVED' :
                   hoveredPinData.category === 'wiegand-reserved' ? '📡 WIEGAND PROTOCOL' :
                   hoveredPinData.category === 'door-io' ? '🔒 DOOR CONTROL' :
                   hoveredPinData.category === 'system-io' ? '⚡ SYSTEM I/O' :
                   hoveredPinData.type === 'power' ? '⚡ POWER' :
                   hoveredPinData.type === 'ground' ? '⏚ GROUND' :
                   '✓ AVAILABLE'}
                </span>
              </div>
            </div>
          </div>
        )}

        {!hoveredPinData && (
          <div className="mt-6 p-4 bg-slate-800/50 rounded-lg border border-slate-700 text-center">
            <p className="text-slate-400 text-sm">
              <Info size={16} className="inline mr-2" />
              Hover over any pin to see its purpose and current assignment
            </p>
          </div>
        )}
      </div>

      {/* Statistics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700">
          <div className="text-sm text-slate-400 mb-1">Total Pins</div>
          <div className="text-2xl font-bold text-white">40</div>
        </div>
        <div className="bg-orange-900/20 rounded-lg p-4 border border-orange-700/50">
          <div className="text-sm text-orange-400 mb-1">HW Reserved</div>
          <div className="text-2xl font-bold text-white">
            {pinout.filter(p => p.category === 'hardware-reserved').length}
          </div>
        </div>
        <div className="bg-blue-900/20 rounded-lg p-4 border border-blue-700/50">
          <div className="text-sm text-blue-400 mb-1">Door I/O</div>
          <div className="text-2xl font-bold text-white">
            {pinout.filter(p => p.category === 'door-io').length}
          </div>
        </div>
        <div className="bg-purple-900/20 rounded-lg p-4 border border-purple-700/50">
          <div className="text-sm text-purple-400 mb-1">Wiegand</div>
          <div className="text-2xl font-bold text-white">
            {pinout.filter(p => p.category === 'wiegand-reserved').length}
          </div>
        </div>
      </div>
    </div>
  );
};

export default GPIOPinoutDiagram;
