#!/usr/bin/env node
// ioplus-adc-bulk.js — AETHER_ZONE_FAST (Update 73)
// Reads all 8 IOplus ADC inputs in millivolts with ONE register read, the same
// way the ioplus CLI reads one: write the register address, then read (two
// plain I2C transactions, no repeated start). Register 0x18 = I2C_MEM_ADC_VAL_MV_ADD
// (Sequent ioplus-rpi src/ioplus.h): 8 x uint16 little-endian, mV.
// Reads twice and prints the second read plus a per-channel "stable" flag (the
// CLI's spurious-read filter: both reads equal ignoring the 2 low bits).
// Usage: node ioplus-adc-bulk.js [stack 0-7] [bus 1]  -> {"mv":[...8],"stable":[...8]}
// Run only through backend/lib/i2cBus (same lock + settle gap as ioplus).
'use strict';
let i2c;
try { i2c = require('i2c-bus'); } catch (e) { process.stderr.write('i2c-bus module not installed\n'); process.exit(3); }
const stack = Math.max(0, Math.min(7, parseInt(process.argv[2] || '0', 10) || 0));
const busNo = parseInt(process.argv[3] || '1', 10) || 1;
const ADDR = 0x28 + stack;
const REG = 0x18;
try {
  const bus = i2c.openSync(busNo);
  const read = () => {
    const w = Buffer.from([REG]);
    if (bus.i2cWriteSync(ADDR, 1, w) !== 1) throw new Error('register write failed');
    const b = Buffer.alloc(16);
    if (bus.i2cReadSync(ADDR, 16, b) !== 16) throw new Error('short read');
    return Array.from({ length: 8 }, (_, i) => b.readUInt16LE(i * 2));
  };
  const a = read();
  const c = read();
  bus.closeSync();
  process.stdout.write(JSON.stringify({ mv: c, stable: c.map((v, i) => (v & 0xfffc) === (a[i] & 0xfffc) || Math.abs(v - a[i]) <= 20) }) + '\n');
} catch (e) {
  process.stderr.write(String(e && e.message || e) + '\n');
  process.exit(1);
}
