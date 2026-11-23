// backend/azure/boardFirmware.js — update Azure Access downstream boards over RS-485  (AETHER_AZURE_FW)
//
// Aether acts as the OSDP controller on the bus and sends the vendor's signed, encrypted
// .upd image with osdp_FILETRANSFER (the same OSDP command Azure's DebugTool uses; the board
// verifies the signature itself). Reuses Aether's OSDP scanner / identifier / uploader.
//
// Safety, in order:
//   1. Package check   .upd is the vendor's DER container (product + generation, signature, payload).
//   2. Bus check       listen first: if another controller (an IC2) is polling this bus, stop.
//                      Two controllers on one RS-485 bus corrupt each other.
//   3. Board check     osdp_ID right before sending: Azure vendor 00-60-EE, product family and
//                      generation must match the package; the serial must be the one confirmed.
//   4. Order           bootloader image first when the release notes require it (Gen3 → 1.27).
//   5. Read-back       after the board restarts: firmware version and output count (XO8 = 16).
// A failed or interrupted transfer leaves the board in its bootloader (TMP/PFLT LEDs alternate);
// it keeps waiting for an image and can be updated again.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const EventEmitter = require('events');

const AZURE_VENDOR = 0x0060EE;
// PDID model byte → product family (seen on BLU-IC2 sites; 2 is the shared IO168 PCB).
const FAMILY = {
  2: { product: 'IO168', label: 'IO168 family (BLU-IO168 / BLU-I16 / BLU-O8)' },
  3: { product: 'RI2M', label: 'BLU-RI2M(D)-S reader interface' },
  4: { product: 'RI4', label: 'BLU-RI4-S reader interface' },
  32: { product: 'IC2', label: 'IC2 on-board reader port' },
};

// ── packages ──────────────────────────────────────────────────────────────────
/** Minimal ZIP reader (stored + deflate), so no npm dependency is needed. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged ZIP directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    p += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;
    if (usize > 64 * 1024 * 1024) throw new Error(`${name} is too large`);
    const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (data) out.push({ name, data });
  }
  return out;
}

function derLen(b, i) {
  const f = b[i];
  if (f < 0x80) return [f, i + 1];
  const k = f & 0x7f;
  if (!k || k > 4) throw new Error('bad DER length');
  let v = 0; for (let j = 0; j < k; j++) v = v * 256 + b[i + 1 + j];
  return [v, i + 1 + k];
}

/** Parse an Azure .upd image: SEQUENCE { string "IO168 Gen4", OCTET STRING signature, OCTET STRING payload }. */
function parseUpd(buf, name = '') {
  if (buf[0] !== 0x30) throw new Error(`${name || 'file'} is not an Azure .upd image`);
  const [total, body] = derLen(buf, 1);
  if (body + total !== buf.length) throw new Error(`${name || 'file'} is truncated or padded (${buf.length} bytes, header says ${body + total})`);
  let i = body;
  if (![0x0c, 0x13, 0x16, 0x1a].includes(buf[i])) throw new Error('no target name in the image');
  let [l, s] = derLen(buf, i + 1);
  const label = buf.subarray(s, s + l).toString('latin1'); i = s + l;
  if (buf[i] !== 0x04) throw new Error('no signature block');
  [l, s] = derLen(buf, i + 1);
  const sig = buf.subarray(s, s + l); i = s + l;
  if (buf[i] !== 0x04) throw new Error('no payload block');
  const [pl, ps] = derLen(buf, i + 1);
  const m = /^(\w+)\s+Gen\s*(\d+)$/i.exec(label.trim());
  return {
    name, label, product: m ? m[1].toUpperCase() : label, gen: m ? +m[2] : null,
    kind: /boot/i.test(name) ? 'bootloader' : 'app',
    size: buf.length, payload: pl, signed: sig[0] === 0x30 && sig.length >= 64,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    end: ps + pl === buf.length,
  };
}

const verNum = v => { const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || '')); return m ? [+m[1], +m[2], +(m[3] || 0)] : null; };
const verCmp = (a, b) => { a = verNum(a); b = verNum(b); if (!a || !b) return null; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

/** Motorola S-record image (.e19 / .s19 / .mot). Stored and saved; Aether does not send these (see plan()). */
function parseSrec(buf, name = '') {
  const text = buf.toString('latin1');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length || !/^S[0-9]/.test(lines[0]) || lines.some(l => !/^S[0-9][0-9A-Fa-f]+$/.test(l.trim()))) throw new Error(`${name || 'file'} is not an S-record image`);
  const s0 = lines.find(l => l.startsWith('S0'));
  const header = s0 ? Buffer.from(s0.slice(8, -2), 'hex').toString('latin1').replace(/[^\x20-\x7e]/g, '').trim() : '';
  const m = /^(\w+)\s+v?(\d+\.\d+(?:\.\d+)?)/i.exec(header);
  const g = /^(\w+)\s+Gen\s*(\d+)/i.exec(header);
  const product = g ? g[1].toUpperCase() : m ? m[1].toUpperCase() : null;
  return {
    name, label: g ? `${product} Gen${g[2]}` : product || header || name, product, gen: g ? +g[2] : null,
    kind: /boot/i.test(name) ? 'bootloader' : 'app', format: 'srec', lines: lines.length,
    size: buf.length, payload: null, signed: false, sha256: crypto.createHash('sha256').update(buf).digest('hex'), end: true,
    header, version: m ? m[2] : null,
  };
}
const IMAGE_RX = /\.(upd|e19|s19|srec|mot)$/i;
const imageOf = (data, name) => {
  if (!IMAGE_RX.test(name)) throw new Error(`${name} is not a firmware package (.zip) or image (.upd, .e19)`);
  return /\.upd$/i.test(name) ? { format: 'upd', ...parseUpd(data, name) } : parseSrec(data, name);
};

/** Read a vendor package (.zip with Firmware/*.upd or *.e19 + release_notes.md, or a bare image). */
function parsePackage(fileName, buf) {
  if (buf.readUInt32LE(0) === 0x04034b50) return parsePackageEntries(fileName, readZip(buf));
  return parsePackageEntries(fileName, null, buf);
}
/** entries: [{ name, data }] from a zip or a folder inside a bulk archive; or a single image in `single`. */
function parsePackageEntries(fileName, entries, single) {
  const files = [];
  let version = null, notes = null;
  if (entries) {
    for (const e of entries) {
      const base = e.name.split('/').pop();
      if (IMAGE_RX.test(base)) files.push({ ...imageOf(e.data, base), data: e.data });
      else if (/release_notes/i.test(base)) {
        notes = e.data.toString('utf8');
        const v = /^###\s*v?(\d+\.\d+(?:\.\d+)?)/m.exec(notes); if (v) version = v[1];
      }
    }
  } else {
    files.push({ ...imageOf(single, fileName), data: single });
  }
  if (!files.length) throw new Error('No firmware image (.upd or .e19) found in the package');
  if (!version) version = files.find(f => f.version)?.version || null;
  if (!version) { const v = /v?(\d+\.\d+(?:\.\d+)?)/.exec(fileName); if (v) version = v[1]; }
  const named = files.filter(f => f.product);
  const products = [...new Set(named.map(f => `${f.product}${f.gen ? ` Gen${f.gen}` : ''}`))];
  if (products.length > 1) throw new Error(`Package mixes targets: ${products.join(', ')}`);
  const lead = files.find(f => f.format === 'upd') || named[0] || files[0];
  // .upd images (1.27+, signed) and .e19 S-record images (the format boards up to 1.26 read) are both sent the
  // way Azure's DebugTool sends them. Only packages for boards Aether knows (IO168, RI2M, RI4) are sendable.
  const sendable = Object.values(FAMILY).some(f => f.product === lead.product && f.product !== 'IC2');
  const label = lead.gen ? `${lead.product} Gen${lead.gen}` : `${lead.product || lead.label}`;
  return {
    fileName, version, product: lead.product, gen: lead.gen, label, sendable,
    files, notes, notesHead: notes ? notes.replace(/\r/g, '').split(/\n### /)[1]?.split('\n').slice(0, 12).join('\n') || null : null,
    bootloaderFirstForGen3: notes ? /gen3.{0,40}bootloader update applied first/i.test(notes) : false, mentionsXo8: notes ? /XO8/i.test(notes) : null,
  };
}

/** Minimal ZIP writer (stored entries) for Save / Save all. */
function writeZip(entries) {
  const crcTable = writeZip.t || (writeZip.t = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const parts = [], central = []; let off = 0;
  const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data } of entries) {
    const nb = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nb, data); central.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// Library order: IO168, RI2M, RI4, then others; newest generation first; newest version first.
const PRODUCT_ORDER = ['IO168', 'RI2M', 'RI4'];
function pkgOrder(a, b) {
  const pa = PRODUCT_ORDER.indexOf(a.product), pb = PRODUCT_ORDER.indexOf(b.product);
  if (pa !== pb) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || String(a.product).localeCompare(String(b.product));
  if ((b.gen || 0) !== (a.gen || 0)) return (b.gen || 0) - (a.gen || 0);
  const v = verCmp(b.version, a.version);
  if (v) return v;
  if (!a.version !== !b.version) return a.version ? -1 : 1;
  return b.addedAt - a.addedAt;
}

// ── board identity + plan ─────────────────────────────────────────────────────
function describeBoard(id, address) {
  const fam = FAMILY[id.modelNumber] || null;
  const outputs = (id.capabilities || []).find(c => c.code === 2);
  const inputs = (id.capabilities || []).find(c => c.code === 1);
  return {
    address, azure: id.vendorCode === AZURE_VENDOR, vendor: id.vendorCode === AZURE_VENDOR ? 'Azure Access' : id.vendorName, model: id.modelNumber, family: fam ? fam.label : `model ${id.modelNumber}`,
    product: fam ? fam.product : null, gen: id.modelVersion, firmware: id.firmwareString, serial: id.serialHex,
    outputs: outputs ? outputs.numItems : null, inputs: inputs ? inputs.numItems : null,
    fileTransfer: id.supportsFiletransfer, secureChannel: id.supportsSecureChannel, rxBuffer: id.maxReceiveBufferSize,
  };
}

function plan(board, pkg, { reinstall = false, bootloader = 'auto' } = {}) {
  const why = [];
  if (pkg.sendable === false) why.push(`${pkg.label} is not a board Aether updates (IO168, RI2M and RI4 only). The package stays in the library so you can Save it.`);
  if (!board.azure) why.push('Not an Azure Access board (vendor is not 00-60-EE).');
  else if (board.product !== pkg.product) why.push(`This package is for ${pkg.label}; the board is ${board.family}.`);
  else if (board.gen !== pkg.gen) why.push(`The board is Gen${board.gen}; this package is Gen${pkg.gen}. The board rejects images for another generation. Get the Gen${board.gen} package.`);
  const notes = [];
  // Capability code 22 (file transfer) is not in the OSDP 2.2 capability table and Azure boards do not list it,
  // even though Azure's own DebugTool updates them with osdp_FILETRANSFER. So for Azure boards it is a note, not a
  // stop: if the board really can't take it, it NAKs and the uploader stops there.
  if (board.fileTransfer === false) {
    if (board.azure) notes.push('The board does not list file transfer in its capabilities (Azure boards don\'t). Azure\'s DebugTool sends the same command. If the board refuses it, Aether stops at the first NAK.');
    else why.push('The board does not report OSDP file-transfer support.');
  }
  const cmp = verCmp(board.firmware, pkg.version);
  const same = cmp !== null && cmp >= 0;
  if (same && !reinstall && !why.length && pkg.files.some(f => f.kind === 'app')) why.push(`Already on ${board.firmware} (package ${pkg.version}). Tick "Reinstall" to send it anyway.`);
  const pick = (kind, format) => pkg.files.find(f => f.kind === kind && f.format === format);
  const app = pick('app', 'upd') || pick('app', 'srec');
  const bootUpd = pick('bootloader', 'upd'), bootSrec = pick('bootloader', 'srec');
  const boot = bootUpd || bootSrec;
  // Boards still on the old update format (before 1.27) read only S-record images, so their bootloader update
  // has to be the .e19; boards already on 1.27 take the signed .upd.
  const oldFormat = verCmp(board.firmware, '1.27.0') < 0;
  const bootRequired = !!boot && board.gen === 3 && pkg.bootloaderFirstForGen3 && oldFormat && verCmp(pkg.version, '1.27.0') >= 0;
  const useBoot = !!boot && (bootloader === 'yes' || (bootloader === 'auto' && bootRequired));
  const bootFile = useBoot ? ((oldFormat && bootSrec) || bootUpd || bootSrec) : null;
  if (useBoot && oldFormat && bootFile.format === 'upd' && app && app.format === 'upd') {
    why.push(`The board is on ${board.firmware}, which reads only S-record (.e19) images, and this package has no bootloader_update.e19. Load the full vendor package (it has Firmware/bootloader_update.e19).`);
  }
  if (!useBoot && bootRequired && app && app.format === 'upd') {
    notes.push(`The board is on ${board.firmware}; Gen3 boards need the bootloader update before they can read the signed 1.27 application, so the board will probably refuse it (status -2).`);
  }
  if (!bootFile && board.gen === 3 && oldFormat && app && app.format === 'upd' && !boot) {
    why.push(`The board is on ${board.firmware} and reads only S-record (.e19) images, so it will refuse this signed app.upd. Select the full ${pkg.product} Gen3 1.27 package (the vendor zip, which has Firmware/bootloader_update.e19); Aether sends that bootloader first, then the application.`);
  }
  const steps = [];
  if (bootFile) steps.push({ kind: 'bootloader', file: bootFile.name, size: bootFile.size, format: bootFile.format });
  if (app) steps.push({ kind: 'app', file: app.name, size: app.size, format: app.format });
  // A bootloader-only package (a lone bootloader_update.e19 / .upd) sends just that image.
  if (!app && boot && bootloader !== 'no' && !steps.length) steps.push({ kind: 'bootloader', file: (oldFormat && bootSrec || boot).name, size: (oldFormat && bootSrec || boot).size, format: (oldFormat && bootSrec || boot).format });
  if (!app && !steps.length) why.push('The package has no application image (app.upd or app.e19).');
  if (!app && steps.length) notes.push('This package holds only the bootloader update. After it, send the application from the full package.');
  return { ok: !why.length, why, notes, steps, bootRequired, from: board.firmware, to: pkg.version };
}

// ── bus guard ─────────────────────────────────────────────────────────────────
/** Listen without sending. Commands (address byte < 0x80) we did not send mean another controller is on the bus. */
async function listenForController(portPath, baudRate, ms = 1500) {
  const { SerialPort } = require('serialport');
  const sp = new SerialPort({ path: portPath, baudRate, autoOpen: false });
  await new Promise((res, rej) => sp.open(e => (e ? rej(e) : res())));
  let buf = Buffer.alloc(0); let commands = 0, replies = 0; const addrs = new Set();
  sp.on('data', d => {
    buf = Buffer.concat([buf, d]);
    for (let i = 0; i + 4 < buf.length; i++) {
      if (buf[i] !== 0x53) continue;
      const len = buf[i + 2] | (buf[i + 3] << 8);
      if (len < 7 || len > 1500) continue;
      if (buf[i + 1] & 0x80) replies++; else { commands++; addrs.add(buf[i + 1]); }
      i += len - 1;
    }
    if (buf.length > 4096) buf = buf.subarray(-512);
  });
  await new Promise(r => setTimeout(r, ms));
  await new Promise(r => sp.close(() => r()));
  return { busy: commands > 0, commands, replies, addresses: [...addrs].sort((a, b) => a - b) };
}

// ── jobs ──────────────────────────────────────────────────────────────────────
class BoardUpdater extends EventEmitter {
  constructor({ dataDir, borrowPort, returnPort, isPortBusy }) {
    super();
    this.dir = path.join(dataDir, 'azure-firmware');
    this.borrowPort = borrowPort || (async () => ({}));
    this.returnPort = returnPort || (async () => {});
    this.isPortBusy = isPortBusy || (() => null);
    this.job = null;
    fs.mkdirSync(this.dir, { recursive: true });
    this.preload();
  }

  // packages: one folder per firmware set; id = hash of the images, so re-adding the same firmware
  // (from the vendor zip or from a saved Aether zip) is recognised.
  savePackage(fileName, buf) { return this.savePackageParsed(parsePackage(fileName, buf)); }
  savePackageParsed(pkg) {
    const id = 'fw-' + crypto.createHash('sha256').update(pkg.files.map(f => f.sha256).sort().join('')).digest('hex').slice(0, 12);
    const d = path.join(this.dir, id);
    const prev = this.pkg(id);
    fs.mkdirSync(d, { recursive: true });
    for (const f of pkg.files) fs.writeFileSync(path.join(d, path.basename(f.name)), f.data);
    if (pkg.notes) fs.writeFileSync(path.join(d, 'release_notes.md'), pkg.notes);
    const { notes, ...rest } = pkg;
    const meta = { id, addedAt: prev ? prev.addedAt : Date.now(), ...rest, files: pkg.files.map(({ data, ...f }) => f), existed: !!prev };
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ ...meta, existed: undefined }, null, 2));
    const mine = new Set(meta.files.map(f => f.sha256));
    for (const o of this.packages()) {
      if (o.id === id || o.product !== meta.product || o.gen !== meta.gen || verCmp(o.version, meta.version) !== 0) continue;
      if (o.files.length < meta.files.length && o.files.every(f => mine.has(f.sha256))) { this.removePackage(o.id); meta.replaced = (meta.replaced || []).concat(o.id); }
    }
    return meta;
  }
  /** Add one or many: a vendor zip, a bare image, or a library zip saved by Aether (zip of zips). */
  savePackages(fileName, buf) {
    if (buf.readUInt32LE(0) === 0x04034b50) {
      const inner = readZip(buf).filter(e => /\.zip$/i.test(e.name));
      if (inner.length) {
        const out = [], errors = [];
        for (const e of inner) { try { out.push(this.savePackage(e.name.split('/').pop(), e.data)); } catch (err) { errors.push(`${e.name}: ${err.message}`); } }
        if (!out.length) throw new Error(errors.join('; ') || 'No firmware packages inside');
        return { packages: out, errors };
      }
    }
    return { packages: [this.savePackage(fileName, buf)], errors: [] };
  }
  /** Save: the package as a zip Aether (or anyone) can load again. */
  packageZip(id) {
    const p = this.pkg(id);
    if (!p) return null;
    const d = path.join(this.dir, id);
    const base = `${(p.product || 'firmware').toLowerCase()}${p.gen ? `_gen${p.gen}` : ''}_v${p.version || 'x'}`;
    const entries = p.files.map(f => ({ name: `${base}/Firmware/${path.basename(f.name)}`, data: fs.readFileSync(path.join(d, path.basename(f.name))) }));
    if (fs.existsSync(path.join(d, 'release_notes.md'))) entries.push({ name: `${base}/release_notes.md`, data: fs.readFileSync(path.join(d, 'release_notes.md')) });
    return { name: `${base}.zip`, data: writeZip(entries) };
  }
  /** Save all: every package, each as its own zip inside one zip (load it back with Add). */
  libraryZip() {
    const entries = this.packages().map(p => this.packageZip(p.id)).filter(Boolean).map(z => ({ name: z.name, data: z.data }));
    return { name: `aether-azure-firmware-${new Date().toISOString().slice(0, 10)}.zip`, data: writeZip(entries) };
  }
  /** Packages shipped with an Aether update land in azure-firmware/preload/*.zip; add each once. */
  preload() {
    const dir = path.join(this.dir, 'preload');
    let added = 0;
    try {
      const doneFile = path.join(dir, '.loaded.json');
      let done = {}; try { done = JSON.parse(fs.readFileSync(doneFile, 'utf8')); } catch { /* */ }
      for (const f of fs.readdirSync(dir).filter(x => /\.(zip|upd|e19)$/i.test(x))) {
        const buf = fs.readFileSync(path.join(dir, f));
        const h = crypto.createHash('sha256').update(buf).digest('hex');
        if (done[f] === h) continue;
        try { this.savePackages(f, buf); done[f] = h; added++; } catch (e) { console.warn(`[AzureFW] preload ${f}: ${e.message}`); }
      }
      if (added) fs.writeFileSync(doneFile, JSON.stringify(done, null, 2));
    } catch { /* no preload folder */ }
    return added;
  }
  packages() {
    try {
      return fs.readdirSync(this.dir).filter(x => x.startsWith('fw-'))
        .map(x => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, x, 'package.json'), 'utf8')); } catch { return null; } })
        .filter(Boolean).sort(pkgOrder);
    } catch { return []; }
  }
  pkg(id) {
    if (!/^fw-[0-9a-f]{12}$/.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, id, 'package.json'), 'utf8')); } catch { return null; }
  }
  removePackage(id) { if (this.pkg(id)) fs.rmSync(path.join(this.dir, id), { recursive: true, force: true }); }
  history() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'history.json'), 'utf8')); } catch { return []; } }
  _addHistory(e) { const h = this.history(); h.unshift(e); fs.writeFileSync(path.join(this.dir, 'history.json'), JSON.stringify(h.slice(0, 300), null, 2)); }

  _check(portPath) {
    if (this.job && this.job.state === 'running') throw new Error('A board update is running. Wait for it to finish or stop it.');
    const why = this.isPortBusy(portPath);
    if (why) throw new Error(why);
  }

  async _withPort(portPath, fn) {
    const lease = await this.borrowPort(portPath);
    try { return await fn(); } finally { try { await new Promise(r => setTimeout(r, 200)); await this.returnPort(portPath, lease); } catch (e) { console.warn('[AzureFW] could not hand the port back:', e.message); } }
  }

  /** Scan an address range: who answers, and who they are. Refuses if another controller is polling. */
  async scan({ portPath, baudRate, from = 0, to = 31 }) {
    this._check(portPath);
    const OSDPFirmwareScanner = require('../osdp/OSDPFirmwareScanner');
    const OSDPFirmwareIdentifier = require('../osdp/OSDPFirmwareIdentifier');
    return this._withPort(portPath, async () => {
      const bus = await listenForController(portPath, baudRate);
      if (bus.busy) return { bus, boards: [] };
      const sc = new OSDPFirmwareScanner({ portPath, baudRate });
      let hits;
      await sc.open();
      try { hits = (await sc.scan({ fromAddr: from, toAddr: to, timeoutMs: 300 })).filter(r => r.replied); } finally { await sc.close(); }
      const boards = [];
      for (const h of hits) {
        const idr = new OSDPFirmwareIdentifier({ portPath, baudRate, address: h.address });
        try { await idr.open(); boards.push(describeBoard(await idr.identify(), h.address)); }
        catch (e) { boards.push({ address: h.address, error: e.message }); }
        finally { await idr.close().catch(() => {}); }
      }
      return { bus, boards };
    });
  }

  async identify(portPath, baudRate, address) {
    const OSDPFirmwareIdentifier = require('../osdp/OSDPFirmwareIdentifier');
    const idr = new OSDPFirmwareIdentifier({ portPath, baudRate, address });
    await idr.open();
    try { return describeBoard(await idr.identify(), address); } finally { await idr.close().catch(() => {}); }
  }

  /** Wake the board the way Scan does (a few POLLs), then identify; try up to 3 times.
   *  A Gen3 IO168 left idle for minutes answered the re-sync POLL but not osdp_ID on the first try. */
  async identifyRetry(portPath, baudRate, address, log = () => {}) {
    const OSDPFirmwareScanner = require('../osdp/OSDPFirmwareScanner');
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const sc = new OSDPFirmwareScanner({ portPath, baudRate });
        await sc.open();
        try { for (let i = 0; i < 3; i++) await sc.scan({ fromAddr: address, toAddr: address, timeoutMs: 500 }); } finally { await sc.close().catch(() => {}); }
        await new Promise(r => setTimeout(r, 150));
        return await this.identify(portPath, baudRate, address);
      } catch (e) {
        last = e;
        log(attempt < 3 ? 'warn' : 'error', `Reading the board's identity (try ${attempt} of 3): ${e.message}`);
        await new Promise(r => setTimeout(r, 700 * attempt));
      }
    }
    throw new Error(`The board at address ${address} did not answer the identity request after 3 tries (${last.message}). Nothing was sent. Check that the board is still powered and on this bus, run Scan again, then retry.`);
  }

  /** Start an update job. Returns immediately; follow it with status(). */
  start({ portPath, baudRate, address, packageId, serial, reinstall = false, bootloader = 'auto', fragmentSize = 110, fileType = 1 }) {
    this._check(portPath);
    const pkg = this.pkg(packageId);
    if (!pkg) throw new Error('Firmware package not found');
    const job = this.job = {
      id: `j${Date.now().toString(36)}`, state: 'running', startedAt: Date.now(), portPath, baudRate, address, packageId,
      package: `${pkg.label} ${pkg.version || ''}`.trim(), step: null, steps: [], progress: null, log: [], result: null, error: null, before: null, after: null,
    };
    const log = (level, msg) => { job.log.push({ t: Date.now(), level, msg }); if (job.log.length > 400) job.log.shift(); this.emit('log', { level, msg }); };
    this._run(job, pkg, { serial, reinstall, bootloader, fragmentSize: Math.max(32, Math.min(1000, +fragmentSize || 110)), fileType: +fileType || 1 }, log)
      .catch(e => { job.state = 'failed'; job.error = e.message; log('error', e.message); })
      .finally(() => {
        job.endedAt = Date.now();
        this._addHistory({ t: job.startedAt, endedAt: job.endedAt, state: job.state, port: portPath, address, package: job.package, before: job.before, after: job.after, error: job.error, steps: job.steps.map(s => ({ kind: s.kind, state: s.state })) });
      });
    return { id: job.id };
  }

  abort() {
    if (!this.job || this.job.state !== 'running') return false;
    this.job.abort = true;
    if (this.job.uploader) this.job.uploader.abort();
    return true;
  }

  status() {
    if (!this.job) return null;
    const { uploader, ...j } = this.job;
    return j;
  }

  async _run(job, pkg, opt, log) {
    const OSDPFirmwareUploader = require('../osdp/OSDPFirmwareUploader');
    await this._withPort(job.portPath, async () => {
      log('info', `Listening on ${job.portPath} for another controller…`);
      const bus = await listenForController(job.portPath, job.baudRate, 2000);
      if (bus.busy) throw new Error(`Another controller is polling this bus (${bus.commands} commands to address ${bus.addresses.join(', ')} in 2 s). Disconnect the IC2 from this RS-485 bus (or move the board onto Aether's bus alone), then try again.`);

      log('info', 'Reading the board\'s identity…');
      const board = await this.identifyRetry(job.portPath, job.baudRate, job.address, log);
      job.before = board;
      log('info', `Board at ${job.address}: ${board.family}, Gen${board.gen}, firmware ${board.firmware}, serial ${board.serial}, outputs ${board.outputs ?? '?'}`);
      if (opt.serial && board.serial !== String(opt.serial).toUpperCase()) throw new Error(`The board at address ${job.address} is serial ${board.serial}, not ${opt.serial} that was confirmed. Nothing was sent.`);
      const p = plan(board, pkg, opt);
      if (!p.ok) throw new Error(p.why.join(' '));
      job.steps = p.steps.map(s => ({ ...s, state: 'pending' }));

      for (const step of job.steps) {
        if (job.abort) throw new Error('Stopped before ' + step.kind);
        job.step = step.kind; step.state = 'sending'; job.progress = null;
        const buf = fs.readFileSync(path.join(this.dir, pkg.id, path.basename(step.file)));
        const srec = step.format === 'srec' || /\.(e19|s19|srec|mot)$/i.test(step.file);
        const records = srec ? buf.toString('latin1').split(/\r?\n/).map(l => l.trim()).filter(l => /^S[0-9]/i.test(l)).map(l => Buffer.from(l, 'latin1')) : null;
        const sendBuf = srec ? Buffer.concat(records) : buf;
        log('info', srec
          ? `Sending ${step.kind} image ${step.file} as S-records (${records.length} lines, one per message, as Azure's DebugTool does)…`
          : `Sending ${step.kind} image ${step.file} (${buf.length} bytes, ${Math.ceil(buf.length / opt.fragmentSize)} fragments of ${opt.fragmentSize} B)…`);
        const send = async () => {
          const up = job.uploader = new OSDPFirmwareUploader({ portPath: job.portPath, baudRate: job.baudRate, address: job.address, useCRC: true, fragmentSize: opt.fragmentSize });
          up.on('progress', pr => { job.progress = { ...pr, at: Date.now() }; });
          up.on('status', s => log(s.level === 'error' ? 'error' : s.level === 'warn' ? 'warn' : 'info', s.message));
          await up.open();
          try { return await up.transferFile(sendBuf, { fileType: opt.fileType, replyTimeoutMs: srec ? 3000 : 10000, fragmentRetries: srec ? 2 : 3, honorMsgMax: true, finalizeTimeoutMs: 10 * 60000, finalizeSilentOk: true, startMessage: !srec, records, restartOnReset: true }); }
          finally { await up.close().catch(() => {}); job.uploader = null; }
        };
        const waitBack = async (ms) => {
          const t0 = Date.now(); await new Promise(r => setTimeout(r, 3000));
          while (Date.now() - t0 < ms && !job.abort) {
            try { return await this.identify(job.portPath, job.baudRate, job.address); } catch { await new Promise(r => setTimeout(r, 2000)); }
          }
          return null;
        };
        try {
          let r = await send();
          // An Azure application answers the start (or the first fragment) with "rebooting" and restarts into its
          // bootloader; the bootloader then needs the whole image from the start. DebugTool retries up to 4 times.
          for (let restart = 1; r.early; restart++) {
            if (restart > 3) throw new Error(`the board ended the transfer early ${restart - 1} times (last after fragment ${r.fragments}, status ${r.finalStatus}) - nothing more was sent`);
            log('info', `The board restarted after ${r.fragments ? `fragment ${r.fragments}` : 'the start message'} (status ${r.finalStatus}) - normally its application handing over to the bootloader. Waiting for it, then sending ${step.file} from the start…`);
            const mid = await waitBack(60000);
            if (!mid) throw new Error('the board did not come back within 60 s after restarting into its bootloader');
            log('info', `Board answering again (firmware ${mid.firmware || '?'}, outputs ${mid.outputs ?? '?'}).`);
            r = await send();
          }
          step.state = 'accepted'; step.finalStatus = r.finalStatus;
          if (r.finalStatus === 'silent') log('info', 'The board went quiet after the last fragment, as it does while it writes the image. Waiting for it to come back…');
        } catch (e) { step.state = 'failed'; throw new Error(`${step.kind} image: ${e.message}. If the TMP and PFLT LEDs alternate the board is waiting in its bootloader; run the update again (Large fragments off).`); }

        log('info', 'Image accepted. Waiting for the board to restart…');
        step.state = 'restarting';
        const t0 = Date.now(); let back = null;
        await new Promise(r => setTimeout(r, 5000));
        while (Date.now() - t0 < 360000 && !job.abort) {
          try { back = await this.identify(job.portPath, job.baudRate, job.address); break; } catch { await new Promise(r => setTimeout(r, 3000)); }
        }
        if (!back) throw new Error(`The board did not answer within 6 minutes after the ${step.kind} image. Check its HB LED (fast blink = offline, TMP/PFLT alternating = still in bootloader).`);
        step.state = 'done'; step.after = back.firmware;
        log('success', `Board back: firmware ${back.firmware}, outputs ${back.outputs ?? '?'}`);
        job.after = back;
      }
      job.state = 'done';
      const xo8 = job.after && job.before && job.after.outputs != null && job.before.outputs != null && job.after.outputs !== job.before.outputs ? ` Outputs changed ${job.before.outputs} → ${job.after.outputs}.` : '';
      job.result = `Updated ${job.before.firmware} → ${job.after ? job.after.firmware : '?'}.${xo8}`;
      log('success', job.result);
    });
  }
}

module.exports = { BoardUpdater, parsePackage, parsePackageEntries, pkgOrder, parseUpd, parseSrec, readZip, writeZip, plan, describeBoard, listenForController, FAMILY, AZURE_VENDOR };
