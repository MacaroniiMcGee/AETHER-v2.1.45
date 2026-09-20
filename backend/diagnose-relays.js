#!/usr/bin/env node
/**
 * IOplus Relay Diagnostic
 * Tests relay addressing across all possible boards
 */

const { execSync } = require('child_process');

function runCmd(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('='.repeat(50));
  console.log('IOplus Relay Diagnostic');
  console.log('='.repeat(50));

  // 1. Detect boards
  console.log('\n[1] Detecting IOplus boards...\n');

  const boards = [];
  for (let stack = 0; stack < 8; stack++) {
    const result = runCmd(`ioplus ${stack} board`);
    if (!result.includes('ERROR') && !result.includes('No IOplus') && !result.includes('Fail')) {
      boards.push(stack);
      console.log(`  ✓ Board ${stack} detected`);
    }
  }

  if (boards.length === 0) {
    console.log('  ✗ No boards detected!');
    process.exit(1);
  }

  console.log(`\n  Total boards: ${boards.length}`);

  // 2. Read current relay states from each board
  console.log('\n[2] Current relay states per board...\n');

  for (const stack of boards) {
    const states = [];
    for (let r = 1; r <= 8; r++) {
      const s = runCmd(`ioplus ${stack} relrd ${r}`);
      states.push(s === '1' ? 'ON' : 'off');
    }
    console.log(`  Board ${stack}: [${states.join(', ')}]`);
  }

  // 3. Test each relay individually
  console.log('\n[3] Testing relays (watch for clicks!)...\n');
  console.log('  Format: Board.Relay = result\n');

  for (const stack of boards) {
    for (let relay = 1; relay <= 8; relay++) {
      const label = `Board${stack}.Relay${relay}`;
      process.stdout.write(`  ${label.padEnd(15)} `);
      
      // Turn ON
      runCmd(`ioplus ${stack} relwr ${relay} 1`);
      const stateOn = runCmd(`ioplus ${stack} relrd ${relay}`);
      process.stdout.write(`ON:${stateOn} `);
      
      await sleep(400);
      
      // Turn OFF  
      runCmd(`ioplus ${stack} relwr ${relay} 0`);
      const stateOff = runCmd(`ioplus ${stack} relrd ${relay}`);
      console.log(`OFF:${stateOff}`);
      
      await sleep(150);
    }
    console.log('');
  }

  // 4. Mapping info
  console.log('[4] Pin-to-Board Mapping\n');
  
  if (boards.length === 1) {
    console.log('  Single board setup:');
    console.log('  Pin 0-7 → Board 0, Relay 1-8');
  } else {
    console.log('  Multi-board setup detected!');
    console.log('  Current mapping should be:');
    for (let i = 0; i < boards.length; i++) {
      const startPin = i * 8;
      const endPin = startPin + 7;
      console.log(`  Pin ${startPin}-${endPin} → Board ${boards[i]}, Relay 1-8`);
    }
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('DONE - Note which relays physically clicked!');
  console.log('='.repeat(50));
}

main().catch(console.error);
