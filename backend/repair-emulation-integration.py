#!/usr/bin/env python3
"""
Aether Emulation Integration — REPAIR INSTALLER
─────────────────────────────────────────────────
Cleanly wires the Controller Emulator's live I/O into the Emulation page's
workflow builder, against the exact code shape of the uploaded files.

What it does — three files, each handled independently and idempotently:

  IOAccessEmulator.tsx
    + adds a controllerInputs state array
    + subscribes the EXISTING socket to emulator-* events (no second socket)
    + on each emulator event, merges live boards' I/O into controllerOutputs
      and controllerInputs (id = address*100 + index for live items)
    + passes controllerInputs down to EmulationSection
    + leaves the 4 static controllerOutputs in place as the fallback when
      the emulator is stopped (they have id 1..4 → never collide with live)

  EmulationSection.tsx
    + adds controllerInputs to the EmulationWorkflowProps interface
    + adds it to the destructure
    + adds helpers: controllerIoFromId, setControllerOutput, readControllerInput,
      isControllerInputId, controllerBoards, controllerItemsForBoard
    + readInput routes controller-input ids to /api/emulator/status
    + io block, ioType==='controller', routes through emulator output API
      (instead of writing Pi GPIO via controlRelay)
    + I/O block editor uses TWO-STEP Board+Output picker for Controller type
    + waitInput and Log/Assert dropdowns also offer controller inputs

  ControllerEmulatorMonitor.tsx
    + already self-contained; not touched
    + (optional usage)  drop <ControllerEmulatorMonitor ipAddress connected />
      onto EmulationSection or wherever you want a live view

Idempotent — re-running is a no-op once installed. Each step makes its own
.bak-repair backup before writing.
"""
from pathlib import Path
import sys
import re

FRONTEND = Path.home() / 'Desktop/Aether/M1.2.2/frontend/src/components'
IOACCESS = FRONTEND / 'IOAccessEmulator.tsx'
EMUSECT  = FRONTEND / 'EmulationSection.tsx'
MONITOR  = FRONTEND / 'ControllerEmulatorMonitor.tsx'


# ════════════════════════════════════════════════════════════════════════
def patch_ioaccess() -> bool:
    print("\n[1/2] IOAccessEmulator.tsx — wire live emulator I/O into state")
    if not IOACCESS.exists():
        print(f"  ✗ NOT FOUND: {IOACCESS}")
        return False
    content = IOACCESS.read_text()
    original = content

    if 'controllerInputs' in content and 'emulator-device-update' in content:
        print("  • Already installed — skipping.")
        return True

    applied = []

    # ── A. Add controllerInputs state right after controllerOutputs state ──
    anchor_after_ctrlout = """  const [controllerOutputs, setControllerOutputs] = useState<OutputItem[]>([
    { id: 1, name: 'Controller Output 1', type: 'None', channel: 0, active: false },
    { id: 2, name: 'Controller Output 2', type: 'None', channel: 1, active: false },
    { id: 3, name: 'Controller Output 3', type: 'None', channel: 2, active: false },
    { id: 4, name: 'Controller Output 4', type: 'None', channel: 3, active: false }
  ]);"""
    if anchor_after_ctrlout not in content:
        print("  ✗ ANCHOR MISS: controllerOutputs initial state block")
        return False
    inject_state = anchor_after_ctrlout + """

  // ── Live Controller Emulator I/O (from /api/emulator/* socket events) ─
  // Live items use id = address*100 + ioIndex (board 12, output 3 -> 1203).
  // The 4 static controllerOutputs above (ids 1..4) act as fallback when the
  // emulator is stopped; live items are appended/replaced separately below.
  const [controllerInputs, setControllerInputs] = useState<InputItem[]>([]);"""
    content = content.replace(anchor_after_ctrlout, inject_state, 1)
    applied.append("added controllerInputs state")

    # ── B. Inside the existing socket useEffect, after input_state_change,
    #       add emulator-* event handlers. Anchor on the closing of the
    #       input_state_change handler — its `});` that ends the listener
    #       block right before `setSocket(newSocket);`.
    anchor_pre_setsocket = """    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
      setSocket(null);
    };
  }, [connected, ipAddress]);"""

    if anchor_pre_setsocket not in content:
        print("  ✗ ANCHOR MISS: setSocket / cleanup block")
        return False

    emu_block = """    // ── Controller Emulator live I/O sync ────────────────────────────
    // Merges live emulated-board I/O into the controllerOutputs / controllerInputs
    // arrays. Live items have id = address*100 + ioIndex, so they never collide
    // with the static fallback (ids 1..4).
    const buildIoFromDevices = (devices: any[]) => {
      const liveOuts: OutputItem[] = [];
      const liveIns:  InputItem[]  = [];
      for (const dev of devices || []) {
        const addr  = dev.address;
        const model = dev.model || '?';
        const nOut  = dev.numOutputs || 0;
        const nIn   = dev.numInputs  || 0;
        for (let i = 0; i < nOut; i++) {
          liveOuts.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} \u2014 Output ${i}`,
            type: 'None',
            channel: i,
            active: !!(dev.outputs && dev.outputs[i]),
          } as OutputItem);
        }
        for (let i = 0; i < nIn; i++) {
          liveIns.push({
            id: addr * 100 + i,
            name: `#${addr} ${model} \u2014 Input ${i}`,
            type: 'General',
            channel: i,
            active: !!(dev.inputs && dev.inputs[i]),
            restingState: 'NO',
          } as InputItem);
        }
      }
      // Keep the 4 static fallback entries (ids 1..4); replace any live ones.
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
    // Initial sync (in case the emulator is already running when we connect)
    refetchEmulatorStatus();

    newSocket.on('emulator-started',        refetchEmulatorStatus);
    newSocket.on('emulator-config-applied', refetchEmulatorStatus);
    newSocket.on('emulator-device-added',   refetchEmulatorStatus);
    newSocket.on('emulator-device-removed', refetchEmulatorStatus);
    newSocket.on('emulator-stopped', () => {
      // Drop live entries on stop; keep the static 4 fallback outputs.
      setControllerOutputs(prev => prev.filter(o => o.id < 100));
      setControllerInputs([]);
    });
    newSocket.on('emulator-device-update', (dev: any) => {
      if (!dev || dev.address == null) return;
      const addr  = dev.address;
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
    content = content.replace(anchor_pre_setsocket, emu_block, 1)
    applied.append("wired emulator socket events into existing socket useEffect")

    # ── C. Pass controllerInputs down to EmulationSection ──────────────────
    old_emu_render = """        {/* EMULATION TAB */}
        {activeTab === 'emulation' && (
          <EmulationSection
            ipAddress={ipAddress}
            connected={connected}
            inputs={inputs}
            outputs={outputs}
            controllerOutputs={controllerOutputs}
            doors={doors}"""
    new_emu_render = """        {/* EMULATION TAB */}
        {activeTab === 'emulation' && (
          <EmulationSection
            ipAddress={ipAddress}
            connected={connected}
            inputs={inputs}
            outputs={outputs}
            controllerOutputs={controllerOutputs}
            controllerInputs={controllerInputs}
            doors={doors}"""
    if old_emu_render in content:
        content = content.replace(old_emu_render, new_emu_render, 1)
        applied.append("passed controllerInputs to EmulationSection")
    else:
        print("  ⚠ EmulationSection render block not matched exactly — pass controllerInputs manually")

    if content == original:
        print("  • No changes written.")
        return True
    IOACCESS.with_suffix('.tsx.bak-repair').write_text(original)
    IOACCESS.write_text(content)
    print(f"  ✓ Backup: IOAccessEmulator.tsx.bak-repair")
    for a in applied:
        print(f"    + {a}")
    return True


# ════════════════════════════════════════════════════════════════════════
def patch_emusect() -> bool:
    print("\n[2/2] EmulationSection.tsx — workflow engine + two-step picker")
    if not EMUSECT.exists():
        print(f"  ✗ NOT FOUND: {EMUSECT}")
        return False
    content = EMUSECT.read_text()
    original = content

    if 'controllerIoFromId' in content:
        print("  • Already installed — skipping.")
        return True

    applied = []

    # ── A. Props interface: add controllerInputs ────────────────────────
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

    # ── B. Destructure: add controllerInputs ────────────────────────────
    old_destr = "  ipAddress, connected, inputs, outputs, controllerOutputs, doors,"
    new_destr = "  ipAddress, connected, inputs, outputs, controllerOutputs, controllerInputs, doors,"
    if old_destr not in content:
        print("  ✗ ANCHOR MISS: destructure line")
        return False
    content = content.replace(old_destr, new_destr, 1)
    applied.append("added controllerInputs to component destructure")

    # ── C. Insert all helpers just before controlRelay ──────────────────
    anchor_controlrelay = "  const controlRelay = async (relayIndex: number, value: 0 | 1) => {"
    if anchor_controlrelay not in content:
        print("  ✗ ANCHOR MISS: controlRelay declaration")
        return False
    helpers = """  // ── Controller Emulator I/O helpers ──────────────────────────────
  // Live controller I/O items use id = address*100 + ioIndex.
  // Static fallback ids 1..4 decode to address 0 and are treated as "no live
  // board" so the helpers degrade gracefully when the emulator is stopped.
  const controllerIoFromId = (id: number): { address: number; index: number } => ({
    address: Math.floor(id / 100),
    index:   id % 100,
  });

  // Drive an emulated board's output via the Controller Emulator API.
  const setControllerOutput = async (address: number, index: number, active: boolean) => {
    if (address < 1) throw new Error('Not a live controller board (emulator may be stopped)');
    const r = await fetch(
      `http://${ipAddress}:3001/api/emulator/device/${address}/output/${index}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }) }
    );
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'controller output failed');
    return j;
  };

  // Read one emulated input via /api/emulator/status snapshot.
  const readControllerInput = async (address: number, index: number): Promise<boolean> => {
    try {
      const r = await fetch(`http://${ipAddress}:3001/api/emulator/status`);
      const j = await r.json();
      if (!j.success || !j.status) return false;
      const dev = (j.status.devices || []).find((d: any) => d.address === address);
      return !!(dev && dev.inputs && dev.inputs[index]);
    } catch (e) { return false; }
  };

  const isControllerInputId = (id: number): boolean =>
    controllerInputs.some(ci => ci.id === id);

  // Two-step picker helpers — derived board list (from live items only).
  const controllerBoards = React.useMemo(() => {
    const map = new Map<number, string>();
    const harvest = (items: { id: number; name: string }[]) => {
      for (const item of items) {
        const address = Math.floor(item.id / 100);
        if (address < 1) continue;  // skip static fallback entries
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

  """ + anchor_controlrelay
    content = content.replace(anchor_controlrelay, helpers, 1)
    applied.append("inserted controller I/O helpers + board derivations")

    # ── D. readInput: route controller-input ids to the emulator ────────
    old_readinput = """  const readInput = async (inputId: number): Promise<boolean> => {
    try {
      const input = inputs.find(i => i.id === inputId); if (!input) return false;
      const response = await fetch(`http://${ipAddress}:3001/api/gpio/read/${input.gpio}`);
      const result = await response.json();
      return result.success ? result.value === 1 : false;
    } catch (e) { return false; }
  };"""
    new_readinput = """  const readInput = async (inputId: number): Promise<boolean> => {
    try {
      if (isControllerInputId(inputId)) {
        const { address, index } = controllerIoFromId(inputId);
        return await readControllerInput(address, index);
      }
      const input = inputs.find(i => i.id === inputId); if (!input) return false;
      const response = await fetch(`http://${ipAddress}:3001/api/gpio/read/${(input as any).gpio}`);
      const result = await response.json();
      return result.success ? result.value === 1 : false;
    } catch (e) { return false; }
  };"""
    if old_readinput in content:
        content = content.replace(old_readinput, new_readinput, 1)
        applied.append("readInput routes controller-input ids to /api/emulator/status")
    else:
        print("  ⚠ readInput exact form changed — patching loosely")
        loose = "  const readInput = async (inputId: number): Promise<boolean> => {\n    try {\n"
        if loose in content:
            inject = ("      if (isControllerInputId(inputId)) {\n"
                      "        const { address, index } = controllerIoFromId(inputId);\n"
                      "        return await readControllerInput(address, index);\n"
                      "      }\n")
            content = content.replace(loose, loose + inject, 1)
            applied.append("readInput controller branch injected (loose)")

    # ── E. io block — route 'controller' type through setControllerOutput ─
    # The existing io block uses readInput / outputs / controllerOutputs and
    # calls controlRelay (Pi GPIO). For 'controller' ioType, redirect to
    # setControllerOutput so the workflow drives the emulated board.
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

          // Controller Emulator output — drive emulated board via /api/emulator
          if (block.ioType === 'controller') {
            const io = controllerOutputs.find(i => i.id === block.ioId);
            const { address, index } = controllerIoFromId(block.ioId || 0);
            const label = io?.name || `Controller Output ${block.ioId}`;
            if (address < 1) {
              addLog(columnIndex, `\u26a0\ufe0f ${label}: emulator not running (static fallback) \u2014 skipped`, 'warning');
              break;
            }
            if (block.action === 'pulse') {
              addLog(columnIndex, `\u26a1 Pulse ${label} (${block.pulseDuration}ms)`, 'info');
              await setControllerOutput(address, index, true);
              await new Promise(r => setTimeout(r, block.pulseDuration || 500));
              await setControllerOutput(address, index, false);
              addLog(columnIndex, `  \u2713 Pulse complete`, 'success');
            } else {
              const on = block.action === 'activate';
              await setControllerOutput(address, index, on);
              addLog(columnIndex, `${on ? '\U0001f7e2' : '\U0001f534'} ${label} ${on ? 'ON' : 'OFF'}`, 'success');
            }
            break;
          }

          // Pi GPIO output (original code path)
          const ioList = outputs;
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
    if old_io in content:
        content = content.replace(old_io, new_io, 1)
        applied.append("io block: 'controller' type routes through setControllerOutput")
    else:
        print("  ⚠ io block body not matched exactly — may need manual patch")

    # ── F. waitInput dropdown — include controller inputs ─────────────────
    # In the uploaded file the input dropdown for waitInput is `{inputs.map(...)}`.
    # We replace that pattern (the unique single occurrence inside the workflow)
    # with [...inputs, ...controllerInputs].map(...). It's a soft-touch change —
    # if EmulationSection has changed in the future, we just leave it as-is.
    flat_pattern = "{inputs.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}"
    if flat_pattern in content:
        content = content.replace(
            flat_pattern,
            "{[...inputs, ...controllerInputs].map(i => <option key={i.id} value={i.id}>{i.name}</option>)}"
        )
        applied.append("input dropdowns (waitInput / assert) include controller inputs")

    # ── G. Two-step picker for the I/O block's Type=Controller ────────────
    # In the uploaded file the I/O block has Type + Select dropdowns. We wrap
    # them so Controller shows Board+Output, and Pi types keep the single list.
    old_type_line = '            <div><label className="text-xs text-slate-400 block mb-1">Type</label><select value={selectedBlock.ioType || \'output\'} onChange={e => updateBlock(selectedBlock.id, { ioType: e.target.value as any, ioId: 1 })} className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm"><option value="output">Output</option><option value="controller">Controller</option><option value="input">Input (Read Only)</option></select></div>'
    old_select_line = '            <div><label className="text-xs text-slate-400 block mb-1">Select</label><select value={selectedBlock.ioId || 1} onChange={e => updateBlock(selectedBlock.id, { ioId: parseInt(e.target.value) })} className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm">{(selectedBlock.ioType === \'output\' ? outputs : selectedBlock.ioType === \'controller\' ? controllerOutputs : inputs).map(io => <option key={io.id} value={io.id}>{io.name}</option>)}</select></div>'

    new_block = '''            <div><label className="text-xs text-slate-400 block mb-1">Type</label><select value={selectedBlock.ioType || 'output'} onChange={e => updateBlock(selectedBlock.id, { ioType: e.target.value as any, ioId: 1 })} className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm"><option value="output">Output</option><option value="controller">Controller</option><option value="input">Input (Read Only)</option></select></div>
            {selectedBlock.ioType === 'controller' ? (
              (() => {
                const currentAddr = Math.floor((selectedBlock.ioId || 0) / 100);
                const items = controllerItemsForBoard(currentAddr, 'output');
                return (
                  <>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Board</label>
                      <select
                        value={currentAddr || ''}
                        onChange={e => {
                          const addr = parseInt(e.target.value) || 0;
                          const first = controllerItemsForBoard(addr, 'output')[0];
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
                      <label className="text-xs text-slate-400 block mb-1">Output</label>
                      <select
                        value={currentAddr ? (selectedBlock.ioId || items[0]?.id || '') : ''}
                        onChange={e => updateBlock(selectedBlock.id, { ioId: parseInt(e.target.value) })}
                        disabled={!currentAddr || items.length === 0}
                        className="w-full bg-black/25 border border-slate-700/50 rounded px-3 py-2 text-sm disabled:opacity-50"
                      >
                        {items.length === 0 && <option value="">— no outputs on this board —</option>}
                        {items.map(io => (
                          <option key={io.id} value={io.id}>
                            Output {io.id % 100}{io.active ? '  \u25cf' : ''}
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
        applied.append("I/O block: two-step Board+Output picker when Type=Controller")
    else:
        print("  ⚠ I/O block editor JSX not matched exactly — left as flat single-dropdown")

    if content == original:
        print("  • No changes written.")
        return True
    EMUSECT.with_suffix('.tsx.bak-repair').write_text(original)
    EMUSECT.write_text(content)
    print(f"  ✓ Backup: EmulationSection.tsx.bak-repair")
    for a in applied:
        print(f"    + {a}")
    return True


# ════════════════════════════════════════════════════════════════════════
def check_monitor() -> bool:
    print("\n[\u00b7] ControllerEmulatorMonitor.tsx — self-contained, no patch needed")
    if not MONITOR.exists():
        print(f"  ! NOT FOUND at {MONITOR}")
        print("    The monitor file should exist from the previous install. If it's")
        print("    missing, copy ControllerEmulatorMonitor.tsx into the components dir.")
        return True   # not fatal — the other patches still help
    print(f"  ✓ Present at {MONITOR.name}")
    print(f"    Optional: drop into a page with")
    print(f"        <ControllerEmulatorMonitor ipAddress={{ipAddress}} connected={{connected}} />")
    return True


# ════════════════════════════════════════════════════════════════════════
def main():
    print("═══════════════════════════════════════════════════════════════")
    print("  Aether Emulation Integration — REPAIR INSTALLER")
    print("═══════════════════════════════════════════════════════════════")
    print(f"  Target: {FRONTEND}")
    if not FRONTEND.exists():
        print(f"\n  ✗ Frontend components dir not found.")
        sys.exit(1)

    ok = True
    ok &= patch_ioaccess()
    ok &= patch_emusect()
    check_monitor()

    print("\n═══════════════════════════════════════════════════════════════")
    if ok:
        print("  ✓ Install complete. Vite should hot-reload.")
        print()
        print("  How to use the integration:")
        print("    1. Make sure the Controller Emulator is running with boards loaded")
        print("    2. Emulation tab → drag an I/O block")
        print("    3. Block editor → Type → Controller")
        print("    4. Pick a Board, then an Output → run the workflow")
        print("    5. Wait Input / Assert blocks: input dropdown now lists")
        print("       controller emulator inputs alongside Pi GPIO inputs")
    else:
        print("  ⚠ One or more steps had issues — see warnings above.")
        sys.exit(2)


if __name__ == '__main__':
    main()
