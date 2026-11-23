// AETHER_AZURE_DEBUG — field troubleshooting checklists for Azure (BLU-IC2) systems.
// Summarised from the Azure Access troubleshooting guide (Part 4) and the NOP-IC2 hardware
// manual (RS-485 bus rules). Each finding points at one of these with `ref` or by its id.
import type { Finding } from './api';

export interface Guide { ref: string; title: string; symptoms: string[]; causes: string[]; steps: string[] }

export const GUIDES: Guide[] = [
  {
    ref: '4.1', title: 'Board not found, offline or dropping off',
    symptoms: ['Board never shows up after it is added', 'Board shows offline or "no communication"', 'Board drops off and comes back'],
    causes: ['TR+ and TR− swapped somewhere on the bus', 'Two boards with the same address on one COM port', 'Termination missing at an end, or switched on in the middle', 'Low or failing power at the board', 'Open, short or noisy cable; no common signal ground', 'DIP switches not matching the address in OnCAFE', 'Board firmware the controller does not support'],
    steps: [
      'List every address on that COM port. Each must be unique and between 0 and 31.',
      'Follow the cable: TR+ to TR+, TR− to TR−, SG to SG on every board.',
      'Bus must be a daisy chain (no star, no stubs over 10 ft). Termination (J2 = COM1, J3 = COM2 on the IC2) only at the two ends.',
      'Measure the supply voltage at the board while relays are energised.',
      'Check continuity of the pair and the signal ground.',
      'Reboot the controller so it enumerates the bus again.',
      'Swap in a known-good board to rule the board itself in or out.',
    ],
  },
  {
    ref: '4.2', title: 'Reader not responding',
    symptoms: ['Card presented, no beep or LED change', 'Reader LED stuck on one colour', 'Reader reads but the door does not open'],
    causes: ['Wrong reader-interface address', 'OSDP vs Wiegand mismatch', 'Reader power off or too weak', 'OSDP secure-channel key mismatch', 'Wiegand format mismatch', 'Data lines crossed, missing ground', 'IC2 reader port N shares a bus with COM N: same baud, unique addresses'],
    steps: [
      'Confirm the reader-interface address in OnCAFE matches the board DIP switches.',
      'Match the protocol (OSDP or Wiegand) to the reader.',
      'Measure voltage at the reader terminals.',
      'For OSDP: check secure channel on/off and the key; for reader ports 1/2 on the IC2, make sure the OSDP address is not used by a board on COM1/COM2.',
      'For Wiegand: confirm the card format (26-bit, 37-bit…).',
      'Test with a known-good card and a known-good reader.',
    ],
  },
  {
    ref: '4.3', title: 'Input shows fault or the wrong state',
    symptoms: ['Input always in fault or trouble', 'Open shows closed (inverted)', 'Input ignores real changes', 'Nuisance alarms'],
    causes: ['Wrong or missing end-of-line resistor', 'Normally-open / normally-closed set wrong', 'Ground loop or shield grounded at both ends', 'Loose or crossed wiring', 'Debounce too short for a noisy contact', 'Worn switch or sensor'],
    steps: [
      'Check the EOL resistor value against the input supervision setting.',
      'Match NO/NC in OnCAFE to the device.',
      'Ground the shield at one end only.',
      'Measure the loop; test the sensor directly with a meter.',
      'Raise the debounce time if the input chatters.',
    ],
  },
  {
    ref: '4.4', title: 'Output does not switch',
    symptoms: ['Valid card, door stays locked', 'Relay does not energise', 'Relay clicks but lock does nothing', 'Manual works, automatic does not'],
    causes: ['Output not tied to the door or automation', 'Schedule keeps the door locked', 'Automation disabled or wrong', 'Relay contacts worn', 'Lock power supply off or blown fuse', 'Lock jammed or coil failed'],
    steps: [
      'Check the output is assigned to the door / output group.',
      'Check the door schedule at this time of day.',
      'Pulse the output from OnCAFE and listen for the relay.',
      'Measure across the relay contacts, then at the lock.',
      'Power the lock directly to rule the relay in or out.',
    ],
  },
  {
    ref: '4.5', title: 'Controller offline, slow or not saving',
    symptoms: ['Controller offline in OnCAFE', 'Card-to-unlock delay; events arrive late or in batches', 'Settings revert after a reboot'],
    causes: ['IP conflict, cable, VLAN or firewall', 'DNS not resolving the cloud host names', 'NTP blocked (time wrong, TLS fails)', 'Too many boards on one RS-485 bus', 'Cloud Connector not installed or not claimed'],
    steps: [
      'Ping the controller and open https://<IP> (the IC2 web page).',
      'From the controller network allow DNS, NTP (UDP 123) and HTTPS (443) / MQTT over TLS to the cloud.',
      'Check the controller is CLAIMED and the Cloud Connector app is running.',
      'Split a busy RS-485 bus across COM1 and COM2.',
      'Back up, then update to the current released firmware and Cloud Connector.',
    ],
  },
  {
    ref: '4.6', title: 'Whole site or random problems',
    symptoms: ['No door works anywhere', 'Valid cards denied at random', 'Forced / held alarms missing in OnCAFE'],
    causes: ['Controller power or network down', 'Credential database not in sync', 'Schedule or access level expired', 'Alarm reporting turned off'],
    steps: [
      'Check controller power and network first.',
      'Re-sync the controller from OnCAFE and watch for sync failures.',
      'Check the identity, its access levels and their schedules.',
      'Check the alarm settings on the door.',
    ],
  },
];

/** Which checklist fits a finding (by explicit ref, else by its id / category). */
export function guideFor(f: Finding): Guide | null {
  const ref = f.ref
    || (/^bus\.|reader-offline|panel\.reader/.test(f.id) ? '4.1'
      : /reader|cred|denied/.test(f.id) ? '4.2'
        : /input|rex|osdp\./.test(f.id) ? '4.3'
          : /relay|strike|output|unlock|door\.(held|forced|sequence|state)/.test(f.id) ? '4.4'
            : /^cloud|^delivery|^panel\.|^sync|^config/.test(f.id) || f.cat === 'cloud' || f.cat === 'delivery' || f.cat === 'panel' ? '4.5'
              : null);
  return GUIDES.find(g => g.ref === ref) || null;
}
