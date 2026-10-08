// analytics/bundle.js — unpack a Cloud Connector log bundle and classify its files.
//
// Accepts the controller's exported .tar.gz/.tgz/.tar (or .zip when `unzip` exists),
// a single .gz, or loose log files. Extraction goes into a fresh temp dir; nothing
// from the bundle is ever executed.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const MAX_FILE = 64 * 1024 * 1024;   // skip anything bigger than this inside a bundle

function mkTemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aether-analytics-')); }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ } }

function sniff(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(512);
  const n = fs.readSync(fd, b, 0, 512, 0);
  fs.closeSync(fd);
  const h = b.subarray(0, n);
  if (h[0] === 0x1f && h[1] === 0x8b) return 'gzip';
  if (h[0] === 0x50 && h[1] === 0x4b) return 'zip';
  if (n >= 262 && h.subarray(257, 262).toString() === 'ustar') return 'tar';
  return 'plain';
}

function extractInto(file, dest, originalName = '') {
  const kind = sniff(file);
  if (kind === 'zip') {
    execFileSync('unzip', ['-qq', '-o', file, '-d', dest], { stdio: 'ignore', timeout: 120000 });
    return 'zip';
  }
  if (kind === 'tar') {
    execFileSync('tar', ['-xf', file, '-C', dest, '--no-same-owner', '--no-same-permissions'], { stdio: 'ignore', timeout: 120000 });
    return 'tar';
  }
  if (kind === 'gzip') {
    // .tar.gz or a single gzipped log?
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    if (raw.length >= 262 && raw.subarray(257, 262).toString() === 'ustar') {
      execFileSync('tar', ['-xzf', file, '-C', dest, '--no-same-owner', '--no-same-permissions'], { stdio: 'ignore', timeout: 120000 });
      return 'tar.gz';
    }
    const name = (originalName || path.basename(file)).replace(/\.gz$/i, '') || 'log';
    fs.writeFileSync(path.join(dest, path.basename(name)), raw);
    return 'gz';
  }
  fs.copyFileSync(file, path.join(dest, path.basename(originalName || file)));
  return 'plain';
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;                 // never follow links out of the bundle
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/') });
  }
  return out;
}

/** Classify one bundle file by name. */
function classify(rel) {
  const b = rel.split('/').pop();
  if (/^CloudConnector\.log(\.\d+)?$/.test(b)) return 'cloudconnector';
  if (/^HealthMonitor\.log(\.\d+)?$/.test(b)) return 'health';
  if (/^SyncTiming\.log(\.\d+)?$/.test(b)) return 'sync';
  if (/^CloudConnectorAuditLog.*\.csv$/i.test(b)) return 'audit';
  if (/^aspsdk_.*\.log$/i.test(b)) return 'aspsdk';
  if (/\.(json|conf)$/i.test(b)) return 'config';
  if (/\.db$/i.test(b)) return 'db';
  if (/\.(log|txt|csv)(\.\d+)?$/i.test(b)) return 'otherlog';
  return 'other';
}

/** Rotated logs: .10 is oldest, bare name is newest. */
function rotIndex(rel) { const m = /\.log\.(\d+)$/.exec(rel); return m ? +m[1] : 0; }

/**
 * Open a bundle (or several uploaded files) into a classified manifest.
 * @param {{path:string,name?:string}[]} inputs
 */
function open(inputs) {
  const dir = mkTemp();
  const sources = [];
  for (const inp of inputs) {
    const sub = fs.mkdtempSync(path.join(dir, 'in-'));
    sources.push({ name: inp.name || path.basename(inp.path), kind: extractInto(inp.path, sub, inp.name) });
  }
  // Archived log snapshots inside the bundle (e.g. log/archive/edgeFwLog-280925-092035.tar.gz):
  // unpack one level deep next to the archive; their files are tagged `archived`.
  let nested = 0;
  for (const f of walk(dir)) {
    if (nested >= 30 || !/\.(tar\.gz|tgz|tar)$/i.test(f.rel)) continue;
    if (fs.statSync(f.abs).size > MAX_FILE) continue;
    const dest = f.abs + '.d';
    try { fs.mkdirSync(dest); extractInto(f.abs, dest, path.basename(f.abs)); nested++; } catch { /* corrupt archive: listed as-is */ }
  }
  const files = walk(dir).map(f => {
    const st = fs.statSync(f.abs);
    const rel = f.rel.replace(/^in-[^/]+\//, '');
    const am = /([^/]+?)\.(?:tar\.gz|tgz|tar)\.d\//i.exec(rel);
    let type = classify(rel);
    if (am && ['cloudconnector', 'health', 'sync', 'audit', 'otherlog'].includes(type)) type = 'archived-' + type;
    if (/\.(tar\.gz|tgz|tar)$/i.test(rel)) type = 'archive';
    return { abs: f.abs, rel, size: st.size, type, skipped: st.size > MAX_FILE, archive: am ? am[1] : null };
  });
  files.sort((a, b) => a.type === b.type ? (rotIndex(b.rel) - rotIndex(a.rel)) || a.rel.localeCompare(b.rel) : a.type.localeCompare(b.type));
  return { dir, sources, files, cleanup: () => rmrf(dir) };
}

module.exports = { open, classify, rmrf };
