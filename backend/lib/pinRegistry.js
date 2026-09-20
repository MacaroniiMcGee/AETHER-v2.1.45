const fs = require("fs");
const path = require("path");

/**
 * PinRegistry - Comprehensive GPIO Pin Management
 * 
 * Manages three categories of reserved pins:
 * 1. Hardware Reserved (I2C, SPI) - NEVER allow I/O operations
 * 2. Wiegand Reserved (D0/D1 pairs) - Only for Wiegand protocol
 * 3. Available I/O - Can be used for door controls and sensors
 */
class PinRegistry {
  constructor() {
    // Load configuration
    const configPath = path.resolve(__dirname, "../config/wiegand-config.json");
    let cfg;
    
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      console.error(`[PinRegistry] Failed to load config from ${configPath}:`, err.message);
      // Fallback to safe defaults
      cfg = {
        chip: "gpiochip0",
        readers: [],
        hardwareReservedPins: {
          i2c_nfc: [2, 3],
          spi_rs485: [7, 8, 9, 10, 11, 25],
          wiegand_rx: []
        },
        availableIOPins: []
      };
    }

    this.chip = cfg.chip || "gpiochip0";
    this.readers = cfg.readers || [];
    
    // Hardware reserved pins (I2C, SPI) - ABSOLUTE no-touch
    this.hardwareReserved = new Set();
    if (cfg.hardwareReservedPins) {
      // I2C for NFC
      (cfg.hardwareReservedPins.i2c_nfc || []).forEach(pin => 
        this.hardwareReserved.add(Number(pin))
      );
      // SPI for RS485 HAT
      (cfg.hardwareReservedPins.spi_rs485 || []).forEach(pin => 
        this.hardwareReserved.add(Number(pin))
      );
    } else {
      // Fallback: hardcode known hardware pins
      [2, 3, 7, 8, 9, 10, 11, 25].forEach(pin => this.hardwareReserved.add(pin));
    }
    
    // Wiegand reserved pins (D0/D1) - Only for Wiegand protocol
    this.wiegandReserved = new Set();
    if (cfg.hardwareReservedPins && cfg.hardwareReservedPins.wiegand_rx) {
      cfg.hardwareReservedPins.wiegand_rx.forEach(pin => 
        this.wiegandReserved.add(Number(pin))
      );
    } else {
      // Extract from readers
      for (const reader of this.readers) {
        if (reader.pins) {
          this.wiegandReserved.add(Number(reader.pins.d0));
          this.wiegandReserved.add(Number(reader.pins.d1));
        }
      }
    }
    
    // All reserved pins (hardware + wiegand)
    this.allReserved = new Set([
      ...this.hardwareReserved,
      ...this.wiegandReserved
    ]);
    
    // Available I/O pins
    this.availableIO = new Set(cfg.availableIOPins || []);
    
    console.log('[PinRegistry] Initialized:');
    console.log(`  Hardware Reserved (I2C/SPI): ${Array.from(this.hardwareReserved).sort((a,b) => a-b).join(', ')}`);
    console.log(`  Wiegand Reserved: ${Array.from(this.wiegandReserved).sort((a,b) => a-b).join(', ')}`);
    console.log(`  Available for I/O: ${Array.from(this.availableIO).sort((a,b) => a-b).join(', ')}`);
  }

  /**
   * Check if a pin is hardware reserved (I2C/SPI)
   * These pins should NEVER be used for any GPIO operations
   */
  isHardwareReserved(pin) {
    return this.hardwareReserved.has(Number(pin));
  }

  /**
   * Check if a pin is Wiegand reserved
   * These pins should only be used by WiegandManager
   */
  isWiegandReserved(pin) {
    return this.wiegandReserved.has(Number(pin));
  }

  /**
   * Check if a pin is reserved for any reason
   * (hardware or Wiegand)
   */
  isReserved(pin) {
    return this.allReserved.has(Number(pin));
  }

  /**
   * Check if a pin is available for general I/O operations
   */
  isAvailableForIO(pin) {
    return this.availableIO.has(Number(pin));
  }

  /**
   * Get the door/reader that uses this pin
   */
  getDoorByPin(pin) {
    const n = Number(pin);
    return this.readers.find((r) => 
      (r.pins && (r.pins.d0 === n || r.pins.d1 === n))
    ) || null;
  }

  /**
   * Get reader configuration by door number
   */
  getDoor(door) {
    return this.readers.find((r) => 
      Number(r.door) === Number(door) || r.id.includes(`door${door}`)
    ) || null;
  }

  /**
   * Get all hardware reserved pins
   */
  listHardwareReserved() {
    return Array.from(this.hardwareReserved.values()).sort((a,b) => a-b);
  }

  /**
   * Get all Wiegand reserved pins
   */
  listWiegandReserved() {
    return Array.from(this.wiegandReserved.values()).sort((a,b) => a-b);
  }

  /**
   * Get all reserved pins (hardware + Wiegand)
   */
  listAllReserved() {
    return Array.from(this.allReserved.values()).sort((a,b) => a-b);
  }

  /**
   * Get all available I/O pins
   */
  listAvailableIO() {
    return Array.from(this.availableIO.values()).sort((a,b) => a-b);
  }

  /**
   * Validate if a pin can be used for I/O operations
   * Returns { valid: boolean, reason: string }
   */
  validatePinForIO(pin) {
    const p = Number(pin);
    
    if (!Number.isInteger(p) || p < 0 || p > 27) {
      return {
        valid: false,
        reason: `Invalid GPIO pin number: ${pin} (must be 0-27)`
      };
    }
    
    if (this.hardwareReserved.has(p)) {
      const device = [2, 3].includes(p) ? 'NFC PN532 (I2C)' : 'RS485 HAT (SPI)';
      return {
        valid: false,
        reason: `GPIO ${p} is HARDWARE RESERVED for ${device}. Cannot be used for I/O operations.`
      };
    }
    
    if (this.wiegandReserved.has(p)) {
      const reader = this.getDoorByPin(p);
      const readerName = reader ? reader.name : 'Wiegand Reader';
      return {
        valid: false,
        reason: `GPIO ${p} is RESERVED for Wiegand communication (${readerName}). Use /api/wiegand endpoints instead.`
      };
    }
    
    return {
      valid: true,
      reason: 'Pin is available for I/O operations'
    };
  }

  /**
   * Get full configuration including categorization
   */
  config() {
    return {
      chip: this.chip,
      readers: this.readers,
      categories: {
        hardwareReserved: this.listHardwareReserved(),
        wiegandReserved: this.listWiegandReserved(),
        availableIO: this.listAvailableIO()
      },
      summary: {
        totalHardwareReserved: this.hardwareReserved.size,
        totalWiegandReserved: this.wiegandReserved.size,
        totalAvailableIO: this.availableIO.size,
        totalGPIOUsed: this.allReserved.size + this.availableIO.size
      }
    };
  }
}

module.exports = new PinRegistry();
