#!/usr/bin/env python3
"""
Aether Emulation Integration — DIRECTION-CORRECTED INSTALLER
─────────────────────────────────────────────────────────────
Fixes the prior repair installer which had I/O direction backwards.

The Controller Emulator pretends to be a downstream OSDP board:
  - inputs[]   = SIMULATED contact/sensor states     → workflow TRIGGERS these
  - outputs[]  = relay states driven BY THE IC2      → workflow READS these only

So the workflow integration should:
  - DRIVE controller inputs (activate / deactivate / pulse / toggle)
  - READ both controller inputs AND outputs (for Wait Input / Assert blocks)

If a previous install (.bak-repair backups) is present, this script REVERTS to
those backups first, then applies the corrected patch from a clean baseline.

Idempotent. Creates .bak-corrected backups before writing.
"""
from pathlib import Path
import sys, shutil

FRONTEND = Path.home() / 'Desktop/Aether/M1.2.2/frontend/src/components'
IOACCESS = FRONTEND / 'IOAccessEmulator.tsx'
EMUSECT  = FRONTEND / 'EmulationSection.tsx'


def revert_if_needed(target: Path):
    """If a .bak-repair backup exists, restore from it (clean baseline)."""
    bak = target.with_suffix(target.suffix + '.bak-repair')
    if bak.exists():
        # Only revert if current file actually has the (wrong-direction) repair applied
        if 'setControllerOutput' in target.read_text() and 'setControllerInput' not in target.read_text():
            print(f"  ↩ Reverting {target.name} from {bak.name} (clean baseline)")
            shutil.copyfile(bak, target)


# ════════════════════════════════════════════════════════════════════════
def patch_ioaccess() -> bool:
    print("\n[1/2] IOAccessEmulator.tsx — live emulator I/O state (inputs + outputs)")
    if not IOACCESS.exists():
        print(f"  ✗ NOT FOUND: {IOACCESS}")
        return False
    revert_if_needed(IOACCESS)
    content = IOACCESS.read_text()
    original = content

    if 'controllerInputs' in content and 'emulator-device-update' in content:
        print("  • Already installed — skipping.")
        return True

    applied = []

    # ── A. Add controllerInputs state after controllerOutputs state ──
    anchor = """  const [controllerOutputs, setControllerOutputs] = useState<OutputItem[]>([
    { id: 1, name: 'Controller Output 1', type: 'None', channel: 0, active: false },
    { id: 2, name: 'Controller Output 2', type: 'None', channel: 1, active: false },
    { id: 3, name: 'Controller Output 3', type: 'None', channel: 2, active: false },
    { id: 4, name: 'Controller Output 4', type: 'None', channel: 3, active: false }
  ]);"""
    if anchor not in content:
        print("  ✗ ANCHOR MISS: controllerOutputs declaration")
        return False
    content = content.replace(anchor, anchor + """

  // ── Live Controller Emulator I/O (from /api/emulator/* socket events) ─
  // Live items use id = address*100 + ioIndex.
  // - controllerInputs : SIMULATED sensors/contacts — workflow triggers these
  // - controllerOutputs (live entries) : relays driven by the IC2 — read-only
  // The 4 static controllerOutputs above (ids 1..4) are kept as fallback
  // when the Controller Emulator is stopped.
  const [controllerInputs, setControllerInputs] = useState<InputItem[]>([]);""", 1)
    applied.append("added controllerInputs state")

    # ── B. Wire emulator-* events into the existing socket useEffect ──
    pre_setsocket = """    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
      setSocket(null);
    };
  }, [connected, ipAddress]);"""
    if pre_setsocket not in content:
        print("  ✗ ANCHOR MISS: setSocket / cleanup block")
        return False

    emu_block = """    // ── Controller Emulator live I/O sync ────────────────────────────
    const buildIoFromDevices = (devices: any[]) => {
      const liveOuts: OutputItem[] = [];
      const liveIns:  InputItem[]  = [];
      for (const dev of devices || []) {
        const addr  = dev.address;
        const model = dev.model || '?';
        for (let i = 0; i < (dev.numOutputs || 0); i++) {
          liveOuts.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} \u2014 Output ${i}`,
            type: 'None', channel: i,
            active: !!(dev.outputs && dev.outputs[i]),
          } as OutputItem);
        }
        for (let i = 0; i < (dev.numInputs || 0); i++) {
          liveIns.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} \u2014 Input ${i}`,
            type: 'General', channel: i,
            active: !!(dev.inputs && dev.inputs[i]),
            restingState: 'NO',
          } as InputItem);
        }
      }
      setControllerOutputs(prev => {
        const staticOnly = prev.filter(o => o.id < 100);
        return [...staticOnly, ...liveOuts].sort((a, b) => a.id - b.id);
      });
      setControllerInputs(liveIns.sort((a, b) => a.id - b.id));
    };

    const refetchEmulatorStatus = async () => {
      try {
        const r = await fetch(`http://${ipAddress}:3001/api/emulator/status`);
        const j = await r.json();
        if (j.success && j.status) buildIoFromDevices(j.status.devices || []);
      } catch (e) { /* emulator may be stopped — that's OK */ }
    };
    refetchEmulatorStatus();

    newSocket.on('emulator-started',        refetchEmulatorStatus);
    newSocket.on('emulator-config-applied', refetchEmulatorStatus);
    newSocket.on('emulator-device-added',   refetchEmulatorStatus);
    newSocket.on('emulator-device-removed', refetchEmulatorStatus);
    newSocket.on('emulator-stopped', () => {
      setControllerOutputs(prev => prev.filter(o => o.id < 100));
      setControllerInputs([]);
    });
    newSocket.on('emulator-device-update', (dev: any) => {
      if (!dev || dev.address == null) return;
      const addr = dev.address;
      const model = dev.model || '?';
      setControllerOutputs(prev => {
        const others = prev.filter(o => o.id < 100 || Math.floor(o.id / 100) !== addr);
        const mine: OutputItem[] = [];
        for (let i = 0; i < (dev.numOutputs || 0); i++) {
          mine.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} \u2014 Output ${i}`,
            type: 'None', channel: i,
            active: !!(dev.outputs && dev.outputs[i]),
          } as OutputItem);
        }
        return [...others, ...mine].sort((a, b) => a.id - b.id);
      });
      setControllerInputs(prev => {
        const others = prev.filter(o => Math.floor(o.id / 100) !== addr);
        const mine: InputItem[] = [];
        for (let i = 0; i < (dev.numInputs || 0); i++) {
          mine.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} \u2014 Input ${i}`,
            type: 'General', channel: i,
            active: !!(dev.inputs && dev.inputs[i]),
            restingState: 'NO',
          } as InputItem);
        }
        return [...others, ...mine].sort((a, b) => a.id - b.id);
      });
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
      setSocket(null);
    };
  }, [connected, ipAddress]);"""
    content = content.replace(pre_setsocket, emu_block, 1)
    applied.append("wired emulator socket events into existing socket useEffect")

    # ── C. Pass controllerInputs down to EmulationSection ──
    old_render = """        {/* EMULATION TAB */}
        {activeTab === 'emulation' && (
          <EmulationSection
            ipAddress={ipAddress}
            connected={connected}
            inputs={inputs}
            outputs={outputs}
            controllerOutputs={controllerOutputs}
            doors={doors}"""
    if old_render in content:
        content = content.replace(old_render, old_render.replace(
            "controllerOutputs={controllerOutputs}",
            "controllerOutputs={controllerOutputs}\n            controllerInputs={controllerInputs}"
        ), 1)
        applied.append("passed controllerInputs to EmulationSection")

    if content == original:
        print("  • No changes written.")
        return True
    IOACCESS.with_suffix('.tsx.bak-corrected').write_text(original)
    IOACCESS.write_text(content)
    print(f"  ✓ Backup: IOAccessEmulator.tsx.bak-corrected")
    for a in applied:
        print(f"    + {a}")
    return True


# ════════════════════════════════════════════════════════════════════════
def patch_emusect() -> bool:
    print("\n[2/2] EmulationSection.tsx — workflow drives inputs, reads outputs")
    if not EMUSECT.exists():
        print(f"  ✗ NOT FOUND: {EMUSECT}")
        return False
    revert_if_needed(EMUSECT)
    content = EMUSECT.read_text()
    original = content

    if 'setControllerInput' in content and 'readControllerOutput' in content:
        print("  • Already installed — skipping.")
        return True

    applied = []

    # ── A. Props interface ──
    old_iface = """  inputs: InputItem[];
  outputs: OutputItem[];
  controllerOutputs: OutputItem[];
  doors: Door[];"""
    new_iface = """  inputs: InputItem[];
  outputs: OutputItem[];
  controllerOutputs: OutputItem[];
  controllerInputs: InputItem[];
  doors: Door[];"""
    if old_iface not in content:
        print("  ✗ ANCHOR MISS: EmulationWorkflowProps interface")
        return False
    content = content.replace(old_iface, new_iface, 1)
    applied.append("added controllerInputs to props interface")

    # ── B. Destructure ──
    old_destr = "  ipAddress, connected, inputs, outputs, controllerOutputs, doors,"
    new_destr = "  ipAddress, connected, inputs, outputs, controllerOutputs, controllerInputs, doors,"
    if old_destr not in content:
        print("  ✗ ANCHOR MISS: destructure")
        return False
    content = content.replace(old_destr, new_destr, 1)
    applied.append("added controllerInputs to destructure")

    # ── C. Helpers — CORRECTED DIRECTION ──
    anchor = "  const controlRelay = async (relayIndex: number, value: 0 | 1) => {"
    if anchor not in content:
        print("  ✗ ANCHOR MISS: controlRelay")
        return False
    helpers = """  // ── Controller Emulator I/O helpers (direction-corrected) ──────────
  //
  // The Controller Emulator pretends to be a downstream OSDP board:
  //   inputs[]  = SIMULATED contact/sensor states  → workflow TRIGGERS these
  //   outputs[] = relays driven by the IC2          → workflow READS only
  //
  // Live items use id = address*100 + ioIndex. Static fallback ids 1..4
  // decode to address 0 and are skipped by the live-API helpers.
  const controllerIoFromId = (id: number): { address: number; index: number } => ({
    address: Math.floor(id / 100),
    index:   id % 100,
  });

  // TRIGGER a simulated input on an emulated board.
  // Workflow drives these to simulate DPS, REX, alarm contacts, etc.
  const setControllerInput = async (address: number, index: number, active: boolean) => {
    if (address < 1) throw new Error('Not a live controller board (emulator may be stopped)');
    const r = await fetch(
      `http://${ipAddress}:3001/api/emulator/device/${address}/input/${index}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }) }
    );
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'controller input trigger failed');
    return j;
  };

  // READ a simulated input's current state from the emulator status snapshot.
  const readControllerInput = async (address: number, index: number): Promise<boolean> => {
    try {
      const r = await fetch(`http://${ipAddress}:3001/api/emulator/status`);
      const j = await r.json();
      if (!j.success || !j.status) return false;
      const dev = (j.status.devices || []).find((d: any) => d.address === address);
      return !!(dev && dev.inputs && dev.inputs[index]);
    } catch (e) { return false; }
  };

  // READ an IC2-driven output's current state. Use this in Assert blocks to
  // verify "IC2 drove output N high after X happened".
  const readControllerOutput = async (address: number, index: number): Promise<boolean> => {
    try {
      const r = await fetch(`http://${ipAddress}:3001/api/emulator/status`);
      const j = await r.json();
      if (!j.success || !j.status) return false;
      const dev = (j.status.devices || []).find((d: any) => d.address === address);
      return !!(dev && dev.outputs && dev.outputs[index]);
    } catch (e) { return false; }
  };

  // Does this input-id reference a live controller-emulator input?
  const isControllerInputId = (id: number): boolean =>
    controllerInputs.some(ci => ci.id === id);

  // Does this output-id reference a live controller-emulator output?
  const isControllerOutputId = (id: number): boolean =>
    controllerOutputs.some(co => co.id === id && co.id >= 100);  // exclude static 1..4

  // Two-step picker helpers — derived board list from live items.
  const controllerBoards = React.useMemo(() => {
    const map = new Map<number, string>();
    const harvest = (items: { id: number; name: string }[]) => {
      for (const item of items) {
        const address = Math.floor(item.id / 100);
        if (address < 1) continue;
        if (!map.has(address)) {
          const m = item.name.match(/^#\\d+\\s+\\S+/);
          map.set(address, m ? m[0] : `#${address}`);
        }
      }
    };
    harvest(controllerOutputs);
    harvest(controllerInputs);
    return Array.from(map.entries())
      .map(([address, label]) => ({ address, label }))
      .sort((a, b) => a.address - b.address);
  }, [controllerOutputs, controllerInputs]);

  const controllerItemsForBoard = (address: number, kind: 'output' | 'input') => {
    const src = kind === 'output' ? controllerOutputs : controllerInputs;
    return src
      .filter(i => Math.floor(i.id / 100) === address)
      .sort((a, b) => (a.id % 100) - (b.id % 100));
  };

  """ + anchor
    content = content.replace(anchor, helpers, 1)
    applied.append("inserted CORRECTED helpers (trigger inputs, read both i/o)")

    # ── D. readInput: route controller-input ids to emulator API ──
    old_read = """  const readInput = async (inputId: number): Promise<boolean> => {
    try {
      const input = inputs.find(i => i.id === inputId); if (!input) return false;
      const response = await fetch(`http://${ipAddress}:3001/api/gpio/read/${input.gpio}`);
      const result = await response.json();
      return result.success ? result.value === 1 : false;
    } catch (e) { return false; }
  };"""
    new_read = """  const readInput = async (inputId: number): Promise<boolean> => {
    try {
      // Controller emulator input?
      if (isControllerInputId(inputId)) {
        const { address, index } = controllerIoFromId(inputId);
        return await readControllerInput(address, index);
      }
      // Controller emulator OUTPUT? (Assert blocks can read IC2-driven outputs)
      if (isControllerOutputId(inputId)) {
        const { address, index } = controllerIoFromId(inputId);
        return await readControllerOutput(address, index);
      }
      // Pi GPIO input
      const input = inputs.find(i => i.id === inputId); if (!input) return false;
      const response = await fetch(`http://${ipAddress}:3001/api/gpio/read/${(input as any).gpio}`);
      const result = await response.json();
      return result.success ? result.value === 1 : false;
    } catch (e) { return false; }
  };"""
    if old_read in content:
        content = content.replace(old_read, new_read, 1)
        applied.append("readInput handles controller inputs AND controller outputs")
    else:
        print("  ⚠ readInput exact form changed — patching loosely")
        loose = "  const readInput = async (inputId: number): Promise<boolean> => {\n    try {\n"
        if loose in content:
            inject = ("      if (isControllerInputId(inputId)) {\n"
                      "        const { address, index } = controllerIoFromId(inputId);\n"
                      "        return await readControllerInput(address, index);\n"
                      "      }\n"
                      "      if (isControllerOutputId(inputId)) {\n"
                      "        const { address, index } = controllerIoFromId(inputId);\n"
                      "        return await readControllerOutput(address, index);\n"
                      "      }\n")
            content = content.replace(loose, loose + inject, 1)
            applied.append("readInput controller branches injected (loose)")

    # ── E. io block — CORRECTED: 'controller' type now means CONTROLLER INPUT ──
    # Adds 'toggle' action support too (per user choice).
    old_io = """        case 'io': {
          if (block.ioType === 'input') { const state = await readInput(block.ioId || 1); addLog(columnIndex, `\U0001f4e5 Input ${block.ioId} state: ${state ? 'HIGH' : 'LOW'}`, 'info'); return; }
          const ioList = block.ioType === 'output' ? outputs : controllerOutputs;
          const io = ioList.find(i => i.id === block.ioId);
          const relayIndex = (block.ioId || 1) - 1;
          if (block.action === 'pulse') {
            addLog(columnIndex, `\u26a1 Pulse ${io?.name || `Output ${block.ioId}`} (${block.pulseDuration}ms)`, 'info');
            await controlRelay(relayIndex, 1);
            await new Promise(r => setTimeout(r, block.pulseDuration || 500));
            await controlRelay(relayIndex, 0);
            addLog(columnIndex, `  \u2713 Pulse complete`, 'success');
          } else {
            const value: 0 | 1 = block.action === 'activate' ? 1 : 0;
            await controlRelay(relayIndex, value);
            addLog(columnIndex, `${value ? '\U0001f7e2' : '\U0001f534'} ${io?.name || `Output ${block.ioId}`} ${value ? 'ON' : 'OFF'}`, 'success');
          }
          break;
        }"""
    new_io = """        case 'io': {
          if (block.ioType === 'input') { const state = await readInput(block.ioId || 1); addLog(columnIndex, `\U0001f4e5 Input ${block.ioId} state: ${state ? 'HIGH' : 'LOW'}`, 'info'); return; }

          // Controller Emulator INPUT trigger — simulate a contact/sensor.
          // We DRIVE inputs (outputs are owned by the IC2 and read-only).
          if (block.ioType === 'controller') {
            const io = controllerInputs.find(i => i.id === block.ioId);
            const { address, index } = controllerIoFromId(block.ioId || 0);
            const label = io?.name || `Controller Input ${block.ioId}`;
            if (address < 1) {
              addLog(columnIndex, `\u26a0\ufe0f ${label}: emulator not running \u2014 skipped`, 'warning');
              break;
            }
            if (block.action === 'pulse') {
              addLog(columnIndex, `\u26a1 Pulse ${label} (${block.pulseDuration}ms)`, 'info');
              await setControllerInput(address, index, true);
              await new Promise(r => setTimeout(r, block.pulseDuration || 500));
              await setControllerInput(address, index, false);
              addLog(columnIndex, `  \u2713 Pulse complete`, 'success');
            } else if (block.action === 'toggle') {
              const current = await readControllerInput(address, index);
              await setControllerInput(address, index, !current);
              addLog(columnIndex, `\U0001f504 ${label} toggled \u2192 ${!current ? 'ON' : 'OFF'}`, 'success');
            } else {
              const on = block.action === 'activate';
              await setControllerInput(address, index, on);
              addLog(columnIndex, `${on ? '\U0001f7e2' : '\U0001f534'} ${label} ${on ? 'ON' : 'OFF'}`, 'success');
            }
            break;
          }

          // Pi GPIO output (unchanged)
          const ioList = outputs;
          const io = ioList.find(i => i.id === block.ioId);
          const relayIndex = (block.ioId || 1) - 1;
          if (block.action === 'pulse') {
            addLog(columnIndex, `\u26a1 Pulse ${io?.name || `Output ${block.ioId}`} (${block.pulseDuration}ms)`, 'info');
            await controlRelay(relayIndex, 1);
            await new Promise(r => setTimeout(r, block.pulseDuration || 500));
            await controlRelay(relayIndex, 0);
            addLog(columnIndex, `  \u2713 Pulse complete`, 'success');
          } else if (block.action === 'toggle') {
            const cur = await readInput(block.ioId || 1);
            await controlRelay(relayIndex, cur ? 0 : 1);
            addLog(columnIndex, `\U0001f504 ${io?.name || `Output ${block.ioId}`} toggled \u2192 ${!cur ? 'ON' : 'OFF'}`, 'success');
          } else {
            const value: 0 | 1 = block.action === 'activate' ? 1 : 0;
            await controlRelay(relayIndex, value);
            addLog(columnIndex, `${value ? '\U0001f7e2' : '\U0001f534'} ${io?.name || `Output ${block.ioId}`} ${value ? 'ON' : 'OFF'}`, 'success');
          }
          break;
        }"""
    if old_io in content:
        content = content.replace(old_io, new_io, 1)
        applied.append("io block: CORRECTED — controller type triggers INPUTS, supports toggle")
    else:
        print("  ⚠ io block body not matched exactly — needs manual patch")

    # ── F. Wait/Assert dropdowns: include controller inputs AND outputs ──
    # Source contains live inputs + live outputs. Reading either is safe via readInput
    # (which routes by id to the appropriate API).
    flat_pattern = "{inputs.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}"
    if flat_pattern in content:
        # Replace with combined list — labels distinguish inputs from outputs naturally
        # because the OUTPUT entries' names contain "Output N" and inputs contain "Input N".
        content = content.replace(
            flat_pattern,
            "{[...inputs, ...controllerInputs, ...controllerOutputs.filter(o => o.id >= 100)].map(i => <option key={i.id} value={i.id}>{i.name}</option>)}"
        )
        applied.append("wait/assert dropdowns include controller inputs AND outputs")

    # ── G. Two-step picker — CORRECTED to source from controllerInputs ──
    old_type_line = '            <div><label className="text-xs text-slate-400 block mb-1">Type</label><select value={selectedBlock.ioType || \'output\'} onChange={e => updateBlock(selectedBlock.id, { ioType: e.target.value as any, ioId: 1 })} className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm"><option value="output">Output</option><option value="controller">Controller</option><option value="input">Input (Read Only)</option></select></div>'
    old_select_line = '            <div><label className="text-xs text-slate-400 block mb-1">Select</label><select value={selectedBlock.ioId || 1} onChange={e => updateBlock(selectedBlock.id, { ioId: parseInt(e.target.value) })} className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm">{(selectedBlock.ioType === \'output\' ? outputs : selectedBlock.ioType === \'controller\' ? controllerOutputs : inputs).map(io => <option key={io.id} value={io.id}>{io.name}</option>)}</select></div>'

    new_block = '''            <div><label className="text-xs text-slate-400 block mb-1">Type</label><select value={selectedBlock.ioType || 'output'} onChange={e => updateBlock(selectedBlock.id, { ioType: e.target.value as any, ioId: 1 })} className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm"><option value="output">Pi GPIO Output</option><option value="controller">Controller Input (simulate)</option><option value="input">Pi GPIO Input (read)</option></select></div>
            {selectedBlock.ioType === 'controller' ? (
              (() => {
                const currentAddr = Math.floor((selectedBlock.ioId || 0) / 100);
                const items = controllerItemsForBoard(currentAddr, 'input');
                return (
                  <>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Board</label>
                      <select
                        value={currentAddr || ''}
                        onChange={e => {
                          const addr = parseInt(e.target.value) || 0;
                          const first = controllerItemsForBoard(addr, 'input')[0];
                          updateBlock(selectedBlock.id, { ioId: first ? first.id : addr * 100 });
                        }}
                        className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm"
                      >
                        {controllerBoards.length === 0 && <option value="">— no boards (start Controller Emulator) —</option>}
                        {controllerBoards.length > 0 && !currentAddr && <option value="">— pick a board —</option>}
                        {controllerBoards.map(b => (
                          <option key={b.address} value={b.address}>{b.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Input (simulated)</label>
                      <select
                        value={currentAddr ? (selectedBlock.ioId || items[0]?.id || '') : ''}
                        onChange={e => updateBlock(selectedBlock.id, { ioId: parseInt(e.target.value) })}
                        disabled={!currentAddr || items.length === 0}
                        className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm disabled:opacity-50"
                      >
                        {items.length === 0 && <option value="">— no inputs on this board —</option>}
                        {items.map(io => (
                          <option key={io.id} value={io.id}>
                            Input {io.id % 100}{io.active ? '  \u25cf' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                );
              })()
            ) : (
              <div><label className="text-xs text-slate-400 block mb-1">Select</label><select value={selectedBlock.ioId || 1} onChange={e => updateBlock(selectedBlock.id, { ioId: parseInt(e.target.value) })} className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm">{(selectedBlock.ioType === 'output' ? outputs : inputs).map(io => <option key={io.id} value={io.id}>{io.name}</option>)}</select></div>
            )}'''

    if old_type_line in content and old_select_line in content:
        content = content.replace(old_select_line, new_block, 1)
        content = content.replace(old_type_line + "\n", "", 1)
        applied.append("I/O block editor: two-step Board+Input picker for Controller (trigger)")
    else:
        print("  ⚠ I/O block editor JSX not matched exactly — left as flat single-dropdown")

    # ── H. Action dropdown — add 'toggle' option ──
    # Find where 'activate'/'deactivate'/'pulse' are listed and add 'toggle'.
    # The action dropdown likely looks like <option value="activate">..., etc.
    # We add a 'toggle' option after pulse if it's not there.
    action_anchor = '<option value="pulse">Pulse</option>'
    if action_anchor in content and 'value="toggle"' not in content:
        content = content.replace(
            action_anchor,
            action_anchor + '<option value="toggle">Toggle</option>',
            1
        )
        applied.append("added 'toggle' action option to I/O block editor")

    if content == original:
        print("  • No changes written.")
        return True
    EMUSECT.with_suffix('.tsx.bak-corrected').write_text(original)
    EMUSECT.write_text(content)
    print(f"  ✓ Backup: EmulationSection.tsx.bak-corrected")
    for a in applied:
        print(f"    + {a}")
    return True


# ════════════════════════════════════════════════════════════════════════
def main():
    print("═══════════════════════════════════════════════════════════════")
    print("  Aether Emulation — DIRECTION-CORRECTED INSTALLER")
    print("═══════════════════════════════════════════════════════════════")
    print(f"  Target: {FRONTEND}")
    if not FRONTEND.exists():
        print(f"\n  ✗ Frontend dir not found.")
        sys.exit(1)

    ok = True
    ok &= patch_ioaccess()
    ok &= patch_emusect()

    print("\n═══════════════════════════════════════════════════════════════")
    if ok:
        print("  ✓ Install complete. Vite should hot-reload.")
        print()
        print("  Direction is now correct:")
        print("    \u2022 Controller INPUTS are TRIGGERED by workflow blocks")
        print("      (simulating DPS, REX, alarm contacts, etc.)")
        print("    \u2022 Controller OUTPUTS are READ ONLY in Wait/Assert blocks")
        print("      (IC2 owns them — workflow verifies what it commanded)")
        print()
        print("  How to use:")
        print("    1. Drag an I/O block \u2192 Type = 'Controller Input (simulate)'")
        print("    2. Pick a Board, then an Input")
        print("    3. Action: Activate / Deactivate / Pulse / Toggle")
        print("    4. Use a Wait Input or Assert block to verify the IC2's")
        print("       response by reading a Controller Output back")
    else:
        print("  ⚠ One or more steps had issues — see warnings above.")
        sys.exit(2)


if __name__ == '__main__':
    main()
