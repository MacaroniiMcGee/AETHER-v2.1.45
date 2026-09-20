// alliedParsers.js — pure text parsers for AlliedWare Plus / GS950 "show" output.
//
// Ported from the desktop tool's Python parsers. Kept free of I/O so they can be
// tested against captured output without touching a switch — which matters,
// because firmware wording varies across the GS950/GS970 range and these
// regexes are the part most likely to need tuning per unit.
//
// Every parser is permissive and returns partial data rather than throwing.
// Anything it cannot read stays 0 / '' / 'Unknown' so the UI can show "not
// reported" instead of a wrong number.

const STATUS = {
  UP: 'up',                    // admin up, link up
  DOWN: 'down',                // admin down — we shut it, or someone did
  DISCONNECTED: 'disconnected',// admin up, link down — nothing plugged in
  UNKNOWN: 'unknown',
};

/** Extract a port number from any line mentioning the interface prefix. */
function portFromText(text, prefix, portCount) {
  const re = new RegExp(`${prefix.replace(/\./g, '\\.')}(\\d+)`, 'i');
  const m = String(text).match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= portCount ? n : null;
}

/** "1.5 K" / "2,340" / "3M" -> integer. */
function parseHumanCounter(raw) {
  if (raw == null) return 0;
  const text = String(raw).trim().replace(/,/g, '');
  const m = text.match(/^([\d.]+)\s*([KMGT])?$/i);
  if (!m) {
    const digits = text.replace(/[^\d]/g, '');
    return digits ? parseInt(digits, 10) : 0;
  }
  const mult = { K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/**
 * `show interface brief` → { port: status }
 *
 * The three-way split matters: "admin up / link down" is a DISCONNECTED port,
 * not a live one. Collapsing that into "up" would let a disconnect scenario
 * run against an empty port and report a clean pass.
 */
function parseBriefStatus(output, prefix, portCount) {
  const statuses = {};
  for (const line of String(output).split('\n')) {
    const tokens = line.trim().split(/\s+/);
    if (!tokens.length || !tokens[0].toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const port = Number(tokens[0].slice(prefix.length));
    if (!Number.isInteger(port) || port < 1 || port > portCount) continue;

    const joined = tokens.slice(1).join(' ').toLowerCase();
    if (joined.includes('admin down')) {
      statuses[port] = STATUS.DOWN;
    } else if (joined.includes('admin up')) {
      const after = joined.slice(joined.indexOf('admin up') + 'admin up'.length).trim();
      statuses[port] = (after.startsWith('down') || after.includes(' down'))
        ? STATUS.DISCONNECTED
        : STATUS.UP;
    }
  }
  return statuses;
}

/**
 * `show lldp neighbors detail` → { port: { hostname, description, remotePort, chassisId } }
 * Handles both per-neighbour blocks and compact tables.
 */
function parseLldpNeighbors(output, prefix, portCount) {
  const devices = {};
  const text = String(output).replace(/\r/g, '');
  const blocks = text.split(/\n\s*\n|(?=^Local (?:Interface|Port))/im);

  for (const block of blocks) {
    const port = portFromText(block, prefix, portCount);
    if (port == null) continue;

    let hostname = '', description = '', remotePort = '', chassisId = '';
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      let m;
      if ((m = line.match(/^(?:System Name|SysName)\s*[:=]\s*(.+)/i))) { hostname = m[1].trim(); continue; }
      if ((m = line.match(/^(?:System Description|SysDescr)\s*[:=]\s*(.+)/i))) { description = m[1].trim(); continue; }
      if ((m = line.match(/^(?:Port Description|Remote Port|Port ID)\s*[:=]\s*(.+)/i))) { remotePort = m[1].trim(); continue; }
      if ((m = line.match(/^(?:Chassis ID|ChassisId)\s*[:=]\s*(.+)/i))) { chassisId = m[1].trim(); }
    }

    // Compact table fallback: local-port | chassis | port-id | system-name
    if (!hostname) {
      for (const line of block.split('\n')) {
        if (portFromText(line, prefix, portCount) !== port) continue;
        const lower = line.toLowerCase();
        if (lower.includes('local port') || lower.includes('system name')) continue;
        const tokens = line.trim().split(/\s+/);
        if (tokens.length >= 4) {
          hostname = tokens[tokens.length - 1];
          chassisId = chassisId || tokens[1];
          remotePort = remotePort || tokens[tokens.length - 2];
          break;
        }
      }
    }

    if (['-', 'N/A', 'n/a'].includes(hostname)) hostname = '';
    if (hostname || description || remotePort || chassisId) {
      devices[port] = { hostname, description, remotePort, chassisId, source: 'lldp' };
    }
  }
  return devices;
}

/**
 * `show mac address-table` → { port: mac }
 * A learned MAC is not a hostname, so it's only ever a secondary tile label.
 */
function parseMacTable(output, prefix, portCount) {
  const result = {};
  const macRe = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}\b/i;

  for (const line of String(output).split('\n')) {
    const macMatch = line.match(macRe);
    if (!macMatch) continue;

    let port = portFromText(line, prefix, portCount);
    if (port == null) {
      // Compact tables often end with a bare port number.
      const trailing = line.match(/(\d+)\s*$/);
      if (trailing) {
        const c = Number(trailing[1]);
        if (c >= 1 && c <= portCount) port = c;
      }
    }
    if (port != null && !(port in result)) result[port] = macMatch[0];
  }
  return result;
}

/**
 * `show interface` detail → { port: { speedMbps, duplex, inOctets, outOctets,
 *                                     inErrors, outErrors, inDiscards, outDiscards } }
 *
 * Firmware writes counters as "Label: value", "value Label", or combined
 * "RX: 120 packets, 98543 bytes" lines. All three are matched; anything absent
 * stays 0 rather than being guessed at.
 */
function parseInterfaceMetrics(output, prefix, portCount) {
  const metrics = {};
  const text = String(output).replace(/\r/g, '');
  if (!text.trim()) return metrics;

  const esc = prefix.replace(/\./g, '\\.');
  const startRe = new RegExp(`^\\s*(?:interface\\s+)?(${esc}\\d+)\\b`, 'gim');
  const starts = [...text.matchAll(startRe)];

  let blocks = [];
  starts.forEach((m, i) => {
    const port = Number(m[1].slice(prefix.length));
    if (!Number.isInteger(port)) return;
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    blocks.push([port, text.slice(m.index, end)]);
  });

  // Some firmware doesn't start blocks with the interface name — group by any
  // line that mentions one.
  if (!blocks.length) {
    const grouped = {};
    let current = null;
    for (const line of text.split('\n')) {
      const found = portFromText(line, prefix, portCount);
      if (found != null) current = found;
      if (current != null) (grouped[current] = grouped[current] || []).push(line);
    }
    blocks = Object.entries(grouped).map(([p, lines]) => [Number(p), lines.join('\n')]);
  }

  const findNumber = (block, labels) => {
    // The unit suffix must be on the SAME line and be a whole token. With \s*
    // here, "7,654,321\n  TX errors" reads the T of the next line as terabytes.
    const num = '([\\d,]+(?:\\.\\d+)?(?:[ \\t]*[KMGT]\\b)?)';
    for (const label of labels) {
      for (const pattern of [`\\b${label}\\b\\s*[:=]?\\s*${num}`, `${num}\\s+\\b${label}\\b`]) {
        const m = block.match(new RegExp(pattern, 'im'));
        if (m) return parseHumanCounter(m[1]);
      }
    }
    return 0;
  };

  for (const [port, block] of blocks) {
    if (port < 1 || port > portCount) continue;
    const lower = block.toLowerCase();

    let speedMbps = 0;
    const speedPatterns = [
      /(?:operational|actual|current|link)?\s*speed\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(g|m)?(?:b(?:it)?\/?s|bps)?/i,
      /\b(10|100|1000|2500|5000|10000)\s*mbps\b/i,
      /\b(1|2\.5|5|10)\s*gbps\b/i,
    ];
    for (let i = 0; i < speedPatterns.length; i++) {
      const m = lower.match(speedPatterns[i]);
      if (m) {
        const n = parseFloat(m[1]);
        const unit = m[2] ? m[2].toLowerCase() : (i === 2 ? 'g' : 'm');
        speedMbps = Math.round(unit === 'g' ? n * 1000 : n);
        break;
      }
    }

    let duplex = 'Unknown';
    if (/\bfull[- ]?duplex\b|duplex\s*[:=]?\s*full/.test(lower)) duplex = 'Full';
    else if (/\bhalf[- ]?duplex\b|duplex\s*[:=]?\s*half/.test(lower)) duplex = 'Half';

    let inOctets = findNumber(block, [
      '(?:rx|receive|received|input|in)\\s+(?:octets|bytes)',
      '(?:octets|bytes)\\s+(?:received|input|in)',
      'ifhcinoctets|ifinoctets',
    ]);
    let outOctets = findNumber(block, [
      '(?:tx|transmit|transmitted|output|out)\\s+(?:octets|bytes)',
      '(?:octets|bytes)\\s+(?:sent|transmitted|output|out)',
      'ifhcoutoctets|ifoutoctets',
    ]);

    // Combined forms: "RX: 120 packets, 98543 bytes"
    if (!inOctets) {
      const m = block.match(/\b(?:rx|receive|received|input)\b[^\n]*?([\d,]+)\s+bytes?/im);
      if (m) inOctets = parseHumanCounter(m[1]);
    }
    if (!outOctets) {
      const m = block.match(/\b(?:tx|transmit|transmitted|output)\b[^\n]*?([\d,]+)\s+bytes?/im);
      if (m) outOctets = parseHumanCounter(m[1]);
    }

    metrics[port] = {
      speedMbps, duplex, inOctets, outOctets,
      inErrors: findNumber(block, [
        '(?:rx|receive|received|input|in)\\s+errors?',
        'errors?\\s+(?:received|input|in)', 'ifinerrors']),
      outErrors: findNumber(block, [
        '(?:tx|transmit|transmitted|output|out)\\s+errors?',
        'errors?\\s+(?:sent|output|out)', 'ifouterrors']),
      inDiscards: findNumber(block, [
        '(?:rx|receive|received|input|in)\\s+(?:discards?|drops?)',
        '(?:discards?|drops?)\\s+(?:received|input|in)', 'ifindiscards']),
      outDiscards: findNumber(block, [
        '(?:tx|transmit|transmitted|output|out)\\s+(?:discards?|drops?)',
        '(?:discards?|drops?)\\s+(?:sent|output|out)', 'ifoutdiscards']),
    };
  }
  return metrics;
}

/**
 * Switch uptime in seconds, from `show system` / `show version`.
 *
 * Worth surfacing: the port control deliberately never writes startup-config,
 * so a switch reboot silently re-enables every port. If uptime resets during a
 * long disconnect test, the run ended early and the result is void.
 */
function parseUptimeSeconds(text) {
  let str = String(text);

  // `show system` prints the current date and time above the uptime line, and
  // that "03:31:07" matches an h:mm:ss pattern just as well as the real value.
  // If a line is explicitly labelled Uptime, use only that line.
  const labelled = str.split('\n').find(l => /\buptime\b/i.test(l));
  if (labelled) str = labelled;

  let total = 0, found = false;

  // Parse "5 days, 04:03:02" first. When this matches it already accounts for
  // the days, so the word matcher below must not count them a second time.
  const hms = str.match(/(?:(\d+)\s+days?[, ]+)?(\d{1,3}):(\d{2}):(\d{2})/i);
  if (hms) {
    total += Number(hms[1] || 0) * 86400 + Number(hms[2]) * 3600 + Number(hms[3]) * 60 + Number(hms[4]);
    found = true;
  }

  const units = { year: 365 * 86400, week: 7 * 86400, day: 86400, hour: 3600, minute: 60, second: 1 };
  for (const [unit, mult] of Object.entries(units)) {
    // Anything the h:mm:ss form already covered is skipped.
    if (hms && ['day', 'hour', 'minute', 'second'].includes(unit)) continue;
    const m = str.match(new RegExp(`(\\d+)\\s*${unit}s?`, 'i'));
    if (m) { total += Number(m[1]) * mult; found = true; }
  }
  return found ? total : 0;
}

/**
 * `show power-inline` → { port: 'enabled' | 'disabled' }
 *
 * ADMINISTRATIVE state only. A port reading "off", "searching" or "not
 * powered" simply has nothing drawing power — that is not the same as PoE
 * having been switched off, and conflating the two would make an untouched
 * port look like one a test had already disabled.
 *
 * Derived from parsePoeInterfaces rather than parsing the table a second time.
 * An earlier version split columns on two-or-more spaces, which works only
 * while the values happen to be short enough to leave that padding:
 *
 *     port1.0.1   Enabled  Crit Powered      <- "Enabled" + 2 spaces, splits
 *     port1.0.8   Disabled High Disabled     <- "Disabled" + 1 space, does not
 *
 * so a disabled port read as unknown while enabled ones read fine. Two parsers
 * over the same text will eventually disagree; one is the fix.
 */
function parsePoeStatus(output, prefix, portCount) {
  const result = {};

  const detail = parsePoeInterfaces(output, prefix, portCount);
  for (const [port, d] of Object.entries(detail)) {
    if (d.admin === 'enabled' || d.admin === 'disabled') result[port] = d.admin;
  }

  // Explicit per-interface configuration wins over the table and also covers
  // firmware that doesn't print one. Config output puts the setting on its own
  // line under an `interface portX` header, so the current interface has to be
  // carried across lines rather than looked for on each one.
  const lines = String(output).replace(/\r/g, '').split('\n')
    .map(l => l.trimEnd()).filter(l => l.trim());

  let currentPort = null;
  for (const line of lines) {
    const named = portFromText(line, prefix, portCount);
    if (named != null) currentPort = named;

    let port = named;
    if (port == null) {
      const m = line.match(/^\s*(\d+)\b/);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= portCount) port = Number(m[1]);
    }
    if (port == null) port = currentPort;
    if (port == null) continue;

    const lowered = line.toLowerCase().split(/\s+/).join(' ');
    if (/\bpower inline (?:never|disabled?)\b/.test(lowered)) result[port] = 'disabled';
    else if (/\bpower inline (?:auto|enabled?)\b/.test(lowered)) result[port] = 'enabled';
    else if (/\bno power-inline enable\b/.test(lowered)) result[port] = 'disabled';
    else if (/\bpower-inline enable\b/.test(lowered)) result[port] = 'enabled';
  }

  return result;
}

/**
 * `show arp` → { byMac: {mac: ip}, byPort: {port: ip}, entries: [...] }
 *
 * The switch learns which MAC sits on which port; ARP maps that MAC to an IP.
 * Together they turn a tile label from "e430.22f2.c2b9" into an address you can
 * actually ping — which matters when LLDP is off, as it is on this estate.
 */
function parseArpTable(output, prefix, portCount) {
  const byMac = {};
  const byPort = {};
  const entries = [];
  const ipRe = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/;
  const macRe = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}\b/i;

  for (const line of String(output).split('\n')) {
    const ipM = line.match(ipRe);
    const macM = line.match(macRe);
    if (!ipM || !macM) continue;

    const ip = ipM[1];
    const mac = macM[0].toLowerCase();
    // Skip the switch's own management entry pointing at a VLAN rather than a port.
    const port = portFromText(line, prefix, portCount);

    byMac[normaliseMac(mac)] = ip;
    if (port != null && !(port in byPort)) byPort[port] = ip;
    entries.push({ ip, mac, port });
  }
  return { byMac, byPort, entries };
}

/** MACs appear as aabb.ccdd.eeff or aa:bb:cc:dd:ee:ff depending on the table. */
function normaliseMac(mac) {
  return String(mac).replace(/[^0-9a-f]/gi, '').toLowerCase();
}

/**
 * The `PoE Status:` preamble of `show power-inline` → switch-wide power budget.
 *
 * Worth surfacing prominently: when Requested exceeds Allocated the switch
 * starts denying power to ports, and which port gets denied can change when a
 * test cuts power elsewhere. That makes PoE test results non-deterministic, so
 * it needs to be visible rather than buried.
 */
function parsePoeBudget(output) {
  const text = String(output);
  const num = (re) => {
    const m = text.match(re);
    return m ? parseFloat(m[1]) : null;
  };
  const budget = {
    nominalW: num(/Nominal Power\s*:\s*([\d.]+)\s*W/i),
    allocatedW: num(/Power Allocated\s*:\s*([\d.]+)\s*W/i),
    requestedW: num(/Power Requested\s*:\s*([\d.]+)\s*W/i),
    consumptionW: num(/Actual Power Consumption\s*:\s*([\d.]+)\s*W/i),
    thresholdPct: num(/Power Usage Threshold\s*:\s*([\d.]+)\s*%/i),
    thresholdW: num(/Power Usage Threshold\s*:\s*[\d.]+\s*%\s*\(([\d.]+)\s*W\)/i),
    operationalStatus: (text.match(/Operational Status\s*:\s*(\w+)/i) || [])[1] || null,
    managementMode: (text.match(/Power management mode\s*:\s*(\w+)/i) || [])[1] || null,
    powerSource: (text.match(/Power Source\s*:\s*(\w+)/i) || [])[1] || null,
  };
  budget.overSubscribed = !!(budget.requestedW && budget.allocatedW && budget.requestedW > budget.allocatedW);
  return budget;
}

/**
 * The `PoE Interface:` table → per-port PoE detail.
 *
 * admin is what someone configured; oper is what the port is doing right now.
 * 'Denied' is neither a fault nor a disable — it means the switch ran out of
 * power budget and refused this port.
 */
function parsePoeInterfaces(output, prefix, portCount) {
  const result = {};
  for (const line of String(output).replace(/\r/g, '').split('\n')) {
    const port = portFromText(line, prefix, portCount);
    if (port == null) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;

    const admin = (fields[1] || '').toLowerCase();
    const priority = fields[2] || null;
    const oper = (fields[3] || '').toLowerCase();
    // Power is the first bare integer after the operational state. Reading it
    // by fixed index breaks as soon as a column width shifts.
    const powerMw = (() => {
      for (let i = 4; i < fields.length; i++) {
        if (/^\d+$/.test(fields[i])) return Number(fields[i]);
        if (fields[i] === 'n/a') return 0;
      }
      return 0;
    })();

    // Class and Max sit at the end and are 'n/a' on unpowered ports.
    const tail = fields.slice(5);
    const maxM = tail.find(f => /^\d{4,}$/.test(f));
    const classM = tail.find(f => /^\d$/.test(f));

    result[port] = {
      admin: ['disabled', 'disable', 'never', 'off'].includes(admin) ? 'disabled'
        : ['enabled', 'enable', 'auto', 'on'].includes(admin) ? 'enabled' : 'unknown',
      oper: oper || 'unknown',
      powerMw,
      priority: priority || null,
      class: classM ? Number(classM) : null,
      maxMw: maxM ? Number(maxM) : null,
      // Called out separately because it looks like a device fault but is a
      // switch budget problem, and it invalidates a PoE test run.
      denied: oper === 'denied',
    };
  }
  return result;
}

module.exports = {
  STATUS,
  portFromText,
  normaliseMac,
  parseHumanCounter,
  parseBriefStatus,
  parseLldpNeighbors,
  parseMacTable,
  parseInterfaceMetrics,
  parseUptimeSeconds,
  parsePoeStatus,
  parseArpTable,
  parsePoeBudget,
  parsePoeInterfaces,
};
