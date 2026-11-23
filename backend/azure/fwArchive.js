// AETHER_AZURE_FW — bulk firmware import.
// Reads a ZIP straight from disk (so a multi-GB "All Azure Releases" archive never has to fit in memory), finds every
// board firmware package in it and adds each one to the library:
//   - vendor package zips at any depth (io168_gen3_v1.27.zip, ri4_gen4_v1.27.zip, …), and zips inside those zips;
//   - unpacked vendor folders (…/io168_gen3_user_tools_v1.27/Firmware/*.upd|*.e19 + release_notes.md);
//   - libraries saved from Aether (a zip of package zips).
// Everything else (IC2 firmware, SDKs, tools) is skipped and counted.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const IMAGE_RX = /\.(upd|e19|s19|srec|mot)$/i;
const MAX_INNER = 48 * 1024 * 1024;     // board packages are 1–3 MB; IC2 images and SDKs are much larger

/** Central directory of a ZIP on disk (ZIP64 aware). */
function zipIndex(fd, size) {
  const tailLen = Math.min(size, 65557 + 20);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Not a ZIP file (or it is damaged)');
  let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = e - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('ZIP64 archive without a locator');
    const e64off = Number(tail.readBigUInt64LE(loc + 8));
    const e64 = Buffer.alloc(56); fs.readSync(fd, e64, 0, 56, e64off);
    if (e64.readUInt32LE(0) !== 0x06064b50) throw new Error('Damaged ZIP64 directory');
    count = Number(e64.readBigUInt64LE(32)); cdSize = Number(e64.readBigUInt64LE(40)); cdOff = Number(e64.readBigUInt64LE(48));
  }
  if (cdSize > 256 * 1024 * 1024) throw new Error('ZIP directory is too large');
  const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
  const out = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.length; k++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged ZIP directory');
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    let lho = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nl).toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
    // ZIP64 extra field: the 0xffffffff sizes/offset are in it, in this order
    let x = p + 46 + nl;
    const xe = x + el;
    while (x + 4 <= xe) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      x += 4 + len;
    }
    p += 46 + nl + el + cl;
    if (!name.endsWith('/')) out.push({ name, method, csize, usize, lho, encrypted: !!(flags & 1) });
  }
  return out;
}

function readEntry(fd, e) {
  if (e.encrypted) throw new Error(`${e.name} is password-protected`);
  const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, e.lho);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`Damaged ZIP entry ${e.name}`);
  const start = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = Buffer.alloc(e.csize); fs.readSync(fd, raw, 0, e.csize, start);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`${e.name}: compression method ${e.method} is not supported`);
}

const base = n => n.split('/').pop();
const looksIc2 = n => /(^|\/)(adk|asp|aspsdk|asp-installation-tool|asp-script-api|update|z9|z9_sdk|z9azure)[_-]/i.test(n) || /\.(img|app|cap)$/i.test(n);

/**
 * Import every board firmware package found in a ZIP on disk.
 * Returns { packages: [meta], existing, skipped: [names], errors: [text] }.
 */
function importArchive(updater, filePath, displayName = base(filePath)) {
  const fd = fs.openSync(filePath, 'r');
  const result = { packages: [], existing: 0, skipped: [], errors: [] };
  const seen = new Set();
  const add = meta => {
    if (seen.has(meta.id)) return;
    seen.add(meta.id);
    if (meta.existed) result.existing++;
    result.packages.push(meta);
  };
  const tryZipBuffer = (name, data, depth) => {
    // a package zip (Firmware/… inside), a library (zips inside), or neither
    let entries;
    try { entries = require('./boardFirmware').readZip(data); } catch (e) { result.errors.push(`${name}: ${e.message}`); return; }
    const images = entries.filter(x => IMAGE_RX.test(x.name));
    const inner = entries.filter(x => /\.zip$/i.test(x.name));
    if (images.length) {
      // one zip may hold one package folder, or several (a user's own bundle): group by the folder above Firmware/
      const groups = groupFolders(entries);
      for (const [root, list] of groups) {
        try { add(updater.savePackageParsed(require('./boardFirmware').parsePackageEntries(groups.length === 1 || root === '' ? base(name) : `${base(name)} › ${base(root)}`, list))); }
        catch (e) { result.errors.push(`${name}${root ? `/${root}` : ''}: ${e.message}`); }
      }
    }
    if (inner.length && depth < 3) for (const z of inner) tryZipBuffer(`${name}/${z.name}`, z.data, depth + 1);
    if (!images.length && !inner.length) result.skipped.push(name);
  };
  try {
    const idx = zipIndex(fd, fs.fstatSync(fd).size);
    // 1. unpacked vendor folders inside the archive
    const folderFiles = idx.filter(e => IMAGE_RX.test(e.name) || /(^|\/)release_notes[^/]*$/i.test(e.name));
    const roots = new Map();
    for (const e of folderFiles) {
      const r = packageRoot(e.name);
      if (r === null) continue;
      if (!roots.has(r)) roots.set(r, []);
      roots.get(r).push(e);
    }
    for (const [root, list] of roots) {
      if (!list.some(e => IMAGE_RX.test(e.name))) continue;
      if (list.some(e => e.usize > MAX_INNER)) { result.skipped.push(root || displayName); continue; }
      try {
        const entries = list.map(e => ({ name: e.name, data: readEntry(fd, e) }));
        add(updater.savePackageParsed(require('./boardFirmware').parsePackageEntries(base(root) || displayName, entries)));
      } catch (e) { result.errors.push(`${root || displayName}: ${e.message}`); }
    }
    // 2. zips inside the archive (vendor packages, Aether libraries)
    for (const e of idx.filter(x => /\.zip$/i.test(x.name))) {
      if (e.usize > MAX_INNER || looksIc2(e.name)) { result.skipped.push(e.name); continue; }
      try { tryZipBuffer(e.name, readEntry(fd, e), 1); } catch (err) { result.errors.push(`${e.name}: ${err.message}`); }
    }
    // 3. everything else is not board firmware
    for (const e of idx) if (!/\.zip$/i.test(e.name) && !folderFiles.includes(e) && !/\/$/.test(e.name) && /\.(img|app|cap|bin|exe)$/i.test(e.name)) result.skipped.push(e.name);
  } finally { fs.closeSync(fd); }
  // quiet the "not firmware" noise: inner zips with no images are just skipped
  result.errors = result.errors.filter(t => !/No firmware image/.test(t));
  return result;
}

/** The folder a vendor package was unpacked into: the part before "Firmware/", or the folder holding release notes. */
function packageRoot(name) {
  const i = name.search(/(^|\/)Firmware\//i);
  if (i >= 0) return name.slice(0, i);
  if (/(^|\/)release_notes[^/]*$/i.test(name)) return name.split('/').slice(0, -1).join('/');
  if (IMAGE_RX.test(name)) return name.split('/').slice(0, -1).join('/');
  return null;
}
function groupFolders(entries) {
  const m = new Map();
  for (const e of entries) {
    if (!IMAGE_RX.test(e.name) && !/(^|\/)release_notes[^/]*$/i.test(e.name)) continue;
    const r = packageRoot(e.name) ?? '';
    if (!m.has(r)) m.set(r, []);
    m.get(r).push(e);
  }
  return [...m].filter(([, list]) => list.some(e => IMAGE_RX.test(e.name)));
}

module.exports = { importArchive, zipIndex, readEntry, packageRoot };
