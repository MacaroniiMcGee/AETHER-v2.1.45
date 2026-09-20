// routes-osdp-firmware.js
//
// OSDP firmware-upload routes plus supporting endpoints for the wizard.
// Pure Node — no Python subprocess. Coordinates serial-port ownership with
// the PD-emulator (OSDPManager) so they don't fight over the same /dev node.
// Streams upload progress over Socket.IO.
//
// Wire it into server.js:
//
//   const attachFirmwareRoutes = require('./routes-osdp-firmware');
//   attachFirmwareRoutes(app, osdpManager, io);
//
// Endpoints:
//   POST   /api/osdp/firmware-scan         body: {port, baud?, fromAddr?, toAddr?}
//   POST   /api/osdp/firmware-identify     body: {port, baud?, address}
//   GET    /api/osdp/firmware-library
//   POST   /api/osdp/firmware-library      (multipart: firmware=<.bin>, metadata={...})
//   DELETE /api/osdp/firmware-library/:id
//   GET    /api/osdp/firmware-history
//   POST   /api/osdp/firmware-upload       (multipart with readerId OR port+address;
//                                           accepts libraryId as alternative to file part)
//   POST   /api/osdp/firmware-abort
//
// Socket.IO events emitted on the main `io` namespace:
//   osdp_firmware_status   { readerId, level, message, ts }
//   osdp_firmware_progress { readerId, phase, fragment, totalFragments,
//                            bytesSent, totalBytes, percent, ftStatus, ftDelay }

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const fs      = require('fs');
const fsp     = require('fs').promises;
const path    = require('path');
const { SerialPort } = require('serialport');

const OSDPFirmwareUploader    = require('./osdp/OSDPFirmwareUploader');
const OSDPFirmwareScanner     = require('./osdp/OSDPFirmwareScanner');
const OSDPFirmwareIdentifier  = require('./osdp/OSDPFirmwareIdentifier');

const UPLOAD_DIR     = path.join(__dirname, 'uploads', 'firmware');
const LIBRARY_DIR    = path.join(__dirname, 'data', 'firmware-library');
const LIBRARY_INDEX  = path.join(__dirname, 'data', 'firmware-library.json');
const HISTORY_FILE   = path.join(__dirname, 'data', 'firmware-history.json');
const HISTORY_MAX    = 500;     // truncate older entries past this
const MAX_FILE_BYTES = 10 * 1024 * 1024;       // 10 MB
const DEFAULT_PORT   = process.env.OSDP_FIRMWARE_PORT
                       || process.env.OSDP_PORT
                       || '/dev/ttyUSB0';
const DEFAULT_BAUD   = parseInt(process.env.OSDP_FIRMWARE_BAUD || process.env.OSDP_BAUD || '9600', 10);

// Only one upload can be in flight at a time (per process). Trying to run two
// concurrently would corrupt the serial state machine on the shared bus.
let activeUpload = null;   // { readerId, uploader, startedAt }

// ---------------------------------------------------------------------------
// Multer setup
// ---------------------------------------------------------------------------

function ensureUploadDir() {
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try { ensureUploadDir(); cb(null, UPLOAD_DIR); }
    catch (e) { cb(e); }
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `fw_${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits:     { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (/\.bin$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .bin firmware files are accepted'));
  },
});

// ---------------------------------------------------------------------------
// Port coordination with OSDPManager
// ---------------------------------------------------------------------------
//
// The PD-emulator keeps serial ports open in `osdpManager.serialPorts` (a Map
// keyed by portPath). Before we can act as a CP on the same port, we must
// release it; afterwards we reopen and re-install the data handler so the
// emulator resumes normal operation.

async function releaseEmulatorPort(osdpManager, portPath) {
  if (!osdpManager || !osdpManager.serialPorts) return { wasOwned: false };

  const existing = osdpManager.serialPorts.get(portPath);
  if (!existing) return { wasOwned: false };

  // Look up the baud rate we need to restore later
  const baudRate = (osdpManager.config &&
                    osdpManager.config.serialPorts &&
                    osdpManager.config.serialPorts.find(p => p.port === portPath)?.baudRate)
                   || DEFAULT_BAUD;

  if (existing.isOpen) {
    await new Promise(resolve => existing.close(() => resolve()));
  }
  osdpManager.serialPorts.delete(portPath);
  return { wasOwned: true, baudRate };
}

async function reopenEmulatorPort(osdpManager, portPath, baudRate) {
  if (!osdpManager) return;
  // Avoid double-open if something already reclaimed it
  if (osdpManager.serialPorts.has(portPath)) {
    const p = osdpManager.serialPorts.get(portPath);
    if (p && p.isOpen) return;
  }

  const sp = new SerialPort({
    path:     portPath,
    baudRate,
    dataBits: 8,
    parity:   'none',
    stopBits: 1,
    autoOpen: false,
    rtscts:   false,
    xon:      false,
    xoff:     false,
  });

  await new Promise((resolve, reject) => {
    sp.open(err => err ? reject(err) : resolve());
  });
  sp.set({ rts: false }, () => {});
  sp.on('error', err => console.error(`[OSDP-FW] emulator port ${portPath} error after reopen:`, err.message));
  sp.on('data',  data => {
    if (typeof osdpManager.handleIncomingData === 'function') {
      osdpManager.handleIncomingData(data, portPath);
    }
  });
  osdpManager.serialPorts.set(portPath, sp);
}

// ---------------------------------------------------------------------------
// Reader resolution
// ---------------------------------------------------------------------------

function resolveReader(osdpManager, readerId) {
  if (!osdpManager) return null;
  if (typeof osdpManager.getReader === 'function') {
    const r = osdpManager.getReader(readerId);
    if (r) return r;
  }
  if (osdpManager.readers && typeof osdpManager.readers.get === 'function') {
    const r = osdpManager.readers.get(readerId);
    if (r) return r;
  }
  // Fallback: address-style lookup if caller passed a decimal/hex address
  const asAddr = /^0x[0-9a-f]+$/i.test(readerId) ? parseInt(readerId, 16)
               : /^\d+$/.test(readerId)          ? parseInt(readerId, 10)
               : null;
  if (asAddr !== null && osdpManager.readers) {
    for (const r of osdpManager.readers.values()) {
      if (r.address === asAddr) return r;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Safe cleanup
// ---------------------------------------------------------------------------

async function unlinkSilently(filePath) {
  if (!filePath) return;
  try { await fsp.unlink(filePath); }
  catch (e) { if (e.code !== 'ENOENT') console.warn(`[OSDP-FW] cleanup unlink failed: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Port / address parsing — used by scan/identify/upload endpoints
// ---------------------------------------------------------------------------

function normalizePort(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.startsWith('/dev/') ? s : `/dev/${s}`;
}

function parseAddress(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const n = /^0x[0-9a-f]+$/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
  if (!Number.isInteger(n) || n < 0 || n > 0x7E) return null;
  return n & 0x7F;
}

function parseBaud(raw) {
  if (raw == null || raw === '') return DEFAULT_BAUD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BAUD;
}

// ---------------------------------------------------------------------------
// Library: bins live in data/firmware-library/, metadata in firmware-library.json
// ---------------------------------------------------------------------------

async function ensureLibraryDir() {
  await fsp.mkdir(LIBRARY_DIR, { recursive: true });
  await fsp.mkdir(path.dirname(LIBRARY_INDEX), { recursive: true });
}

async function readLibraryIndex() {
  try {
    const txt = await fsp.readFile(LIBRARY_INDEX, 'utf8');
    const json = JSON.parse(txt);
    return Array.isArray(json) ? json : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeLibraryIndex(entries) {
  await ensureLibraryDir();
  await fsp.writeFile(LIBRARY_INDEX, JSON.stringify(entries, null, 2));
}

// SHA-256 of a file — used for integrity in the library
async function sha256File(filePath) {
  const data = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// History: append-only log of past upload attempts
// ---------------------------------------------------------------------------

async function readHistory() {
  try {
    const txt = await fsp.readFile(HISTORY_FILE, 'utf8');
    const json = JSON.parse(txt);
    return Array.isArray(json) ? json : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function appendHistory(entry) {
  await fsp.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  const list = await readHistory();
  list.unshift({ ts: Date.now(), ...entry });
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  await fsp.writeFile(HISTORY_FILE, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------------------
// Route attachment
// ---------------------------------------------------------------------------

module.exports = function attachFirmwareRoutes(app, osdpManager, io) {
  // Multer's fileFilter rejections come back via `next(err)`, so we wrap
  // single() to translate them into clean JSON 400s.
  const uploadMw = (req, res, next) => {
    upload.single('firmware')(req, res, err => {
      if (err) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ success: false, error: err.message || String(err) });
      }
      next();
    });
  };

  app.post('/api/osdp/firmware-upload', uploadMw, async (req, res) => {
    const uploadedFilePath = req.file && req.file.path;
    const body = req.body || {};
    const hasFile      = !!req.file;
    const hasLibraryId = body.libraryId != null && body.libraryId !== '';

    // ---- Pre-flight: file source ----
    if (!hasFile && !hasLibraryId) {
      return res.status(400).json({ success: false, error: 'Provide either a `firmware` file part or `libraryId` referencing an existing library entry' });
    }
    if (activeUpload) {
      await unlinkSilently(uploadedFilePath);
      return res.status(409).json({
        success: false,
        error: `Another firmware upload is already in progress (reader ${activeUpload.readerId})`,
      });
    }

    // ---- Pre-flight: target source ----
    const hasDirectOverride = body.port != null && body.address != null;
    const hasReaderId       = body.readerId != null && body.readerId !== '';

    if (!hasDirectOverride && !hasReaderId) {
      await unlinkSilently(uploadedFilePath);
      return res.status(400).json({
        success: false,
        error: 'Provide either readerId, OR port + address (and optionally baud). ' +
               'Direct example: -F port=ttyACM0 -F baud=9600 -F address=0',
      });
    }

    // ---- Optional confirmation phrase (the wizard's permission gate) ----
    // If the caller provides `expectedConfirmation`, we check `confirmationPhrase` matches.
    if (body.expectedConfirmation && body.confirmationPhrase !== body.expectedConfirmation) {
      await unlinkSilently(uploadedFilePath);
      return res.status(400).json({ success: false, error: 'Confirmation phrase did not match' });
    }

    // ---- Resolve target: portPath, baudRate, address, displayName, readerId ----
    let portPath, baudRate, address, displayName, displayId;

    if (hasDirectOverride) {
      // Direct mode — caller supplied port/address explicitly. No osdpManager lookup.
      const rawPort = String(body.port).trim();
      portPath = rawPort.startsWith('/dev/') ? rawPort : `/dev/${rawPort}`;

      const rawBaud = body.baud != null ? Number(body.baud) : DEFAULT_BAUD;
      if (!Number.isFinite(rawBaud) || rawBaud <= 0) {
        await unlinkSilently(uploadedFilePath);
        return res.status(400).json({ success: false, error: `Invalid baud: ${body.baud}` });
      }
      baudRate = rawBaud;

      const rawAddr = String(body.address).trim();
      const parsedAddr = /^0x[0-9a-f]+$/i.test(rawAddr) ? parseInt(rawAddr, 16) : parseInt(rawAddr, 10);
      if (!Number.isInteger(parsedAddr) || parsedAddr < 0 || parsedAddr > 0x7E) {
        await unlinkSilently(uploadedFilePath);
        return res.status(400).json({ success: false, error: `Invalid address: ${body.address} (must be 0-126)` });
      }
      address = parsedAddr & 0x7F;

      displayId   = `direct:${portPath}@${baudRate}#${address}`;
      displayName = `direct (${portPath} @ ${baudRate}, addr 0x${address.toString(16).padStart(2,'0')})`;
    } else {
      // Reader-lookup mode (original behavior).
      if (!osdpManager) {
        await unlinkSilently(uploadedFilePath);
        return res.status(503).json({ success: false, error: 'OSDP manager not initialized' });
      }
      const reader = resolveReader(osdpManager, body.readerId);
      if (!reader) {
        await unlinkSilently(uploadedFilePath);
        return res.status(404).json({ success: false, error: `Reader '${body.readerId}' not found` });
      }
      portPath    = reader.serialPort || DEFAULT_PORT;
      baudRate    = (osdpManager.config &&
                     osdpManager.config.serialPorts &&
                     osdpManager.config.serialPorts.find(p => p.port === portPath)?.baudRate)
                    || DEFAULT_BAUD;
      address     = reader.address & 0x7F;
      displayId   = reader.id;
      displayName = reader.name;
    }

    // ---- Load the firmware bytes from either source ----
    let fileBuffer;
    let sourceLabel;
    try {
      if (hasFile) {
        fileBuffer = await fsp.readFile(uploadedFilePath);
        sourceLabel = `uploaded:${req.file.originalname}`;
      } else {
        const entries = await readLibraryIndex();
        const entry = entries.find(e => e.id === body.libraryId);
        if (!entry) {
          return res.status(404).json({ success: false, error: `Library entry '${body.libraryId}' not found` });
        }
        if (!entry.storedPath) {
          return res.status(500).json({ success: false, error: `Library entry '${body.libraryId}' has no stored path` });
        }
        fileBuffer = await fsp.readFile(entry.storedPath);
        sourceLabel = `library:${entry.filename}`;
      }
    } catch (e) {
      await unlinkSilently(uploadedFilePath);
      return res.status(500).json({ success: false, error: `Failed to read firmware bytes: ${e.message}` });
    }

    console.log(`[OSDP-FW] Upload requested: reader=${displayName} (id=${displayId}, addr=0x${address.toString(16).padStart(2,'0')}) port=${portPath}@${baudRate} bytes=${fileBuffer.length} src=${sourceLabel}`);

    // ---- Coordinate port ownership ----
    let portReleased = false;
    let restoreBaud  = baudRate;
    try {
      const releaseInfo = await releaseEmulatorPort(osdpManager, portPath);
      portReleased = releaseInfo.wasOwned;
      if (releaseInfo.baudRate) restoreBaud = releaseInfo.baudRate;
      if (portReleased) console.log(`[OSDP-FW] Released ${portPath} from PD emulator for firmware push`);
    } catch (e) {
      console.error(`[OSDP-FW] Could not release ${portPath} from emulator:`, e.message);
      await unlinkSilently(uploadedFilePath);
      return res.status(500).json({ success: false, error: `Failed to release serial port: ${e.message}` });
    }

    // ---- Run the upload ----
    const uploader = new OSDPFirmwareUploader({
      portPath, baudRate, address, useCRC: true,
    });

    activeUpload = {
      readerId: displayId,
      reader:   displayName,
      uploader,
      startedAt:    Date.now(),
      port:         portPath,
      baud:         baudRate,
      address,
      totalBytes:   fileBuffer.length,
      filename:     req.file ? req.file.originalname : (body.libraryId ? `library:${body.libraryId}` : null),
      lastProgress: null,
      lastStatus:   null,
    };

    const emit = (event, payload) => {
      if (io && typeof io.emit === 'function') io.emit(event, { readerId: displayId, ...payload });
    };
    uploader.on('progress', p => {
      if (activeUpload) activeUpload.lastProgress = { ...p, ts: Date.now() };
      emit('osdp_firmware_progress', p);
    });
    uploader.on('status', s => {
      if (activeUpload) activeUpload.lastStatus = { ...s, ts: Date.now() };
      emit('osdp_firmware_status', s);
    });
    uploader.on('error', e => emit('osdp_firmware_status', { level: 'error', message: e.message, ts: Date.now() }));

    let result = null;
    let failure = null;
    try {
      await uploader.open();
      result = await uploader.transferFile(fileBuffer);
      console.log(`[OSDP-FW] ✓ Upload complete: ${result.bytesSent} bytes / ${result.fragments} fragments / finalStatus=${result.finalStatus}`);
    } catch (e) {
      failure = e;
      console.error(`[OSDP-FW] ✗ Upload failed:`, e.message);
      emit('osdp_firmware_status', { level: 'error', message: e.message, ts: Date.now() });
    } finally {
      try { await uploader.close(); } catch (e) { /* ignore */ }
      activeUpload = null;

      // Restore the PD emulator on this port — but only if the reader did NOT
      // reboot. A REBOOTING status means the reader is power-cycling and will
      // not respond to anything for several seconds; the next emulator poll
      // would just spam errors. We still need to reopen the port so that when
      // the reader comes back, replies route correctly.
      if (portReleased) {
        try {
          // Small grace period — even on a happy path the reader may need a
          // moment to settle before normal traffic resumes.
          await new Promise(r => setTimeout(r, 500));
          await reopenEmulatorPort(osdpManager, portPath, restoreBaud);
          console.log(`[OSDP-FW] Restored ${portPath} to PD emulator`);
        } catch (e) {
          console.warn(`[OSDP-FW] Could not reopen ${portPath} for emulator: ${e.message}`);
        }
      }

      await unlinkSilently(uploadedFilePath);
    }

    if (failure) {
      await appendHistory({
        result:   'failure',
        error:    failure.message,
        reader:   displayName,
        readerId: displayId,
        port:     portPath,
        baud:     baudRate,
        address,
        filename: req.file ? req.file.originalname : (body.libraryId ? `library:${body.libraryId}` : null),
        sizeBytes: fileBuffer.length,
        durationMs: result ? Date.now() - activeUpload?.startedAt : null,
      }).catch(e => console.warn('[OSDP-FW] history write failed:', e.message));

      return res.status(500).json({
        success:  false,
        error:    failure.message,
        reader:   displayName,
        readerId: displayId,
        port:     portPath,
        baud:     baudRate,
        address,
      });
    }

    await appendHistory({
      result:      'success',
      reader:      displayName,
      readerId:    displayId,
      port:        portPath,
      baud:        baudRate,
      address,
      filename:    req.file ? req.file.originalname : (body.libraryId ? `library:${body.libraryId}` : null),
      sizeBytes:   result.bytesSent,
      fragments:   result.fragments,
      finalStatus: result.finalStatus,
      rebooting:   result.finalStatus === OSDPFirmwareUploader.FT_STATUS.REBOOTING,
    }).catch(e => console.warn('[OSDP-FW] history write failed:', e.message));

    return res.json({
      success:     true,
      message:     'Firmware uploaded successfully',
      reader:      displayName,
      readerId:    displayId,
      port:        portPath,
      baud:        baudRate,
      address,
      bytesSent:   result.bytesSent,
      fragments:   result.fragments,
      finalStatus: result.finalStatus,
      rebooting:   result.finalStatus === OSDPFirmwareUploader.FT_STATUS.REBOOTING,
    });
  });

  // ---- Abort current upload ----
  app.post('/api/osdp/firmware-abort', (_req, res) => {
    if (!activeUpload) return res.status(409).json({ success: false, error: 'No upload in progress' });
    try { activeUpload.uploader.abort(); }
    catch (e) { return res.status(500).json({ success: false, error: e.message }); }
    return res.json({ success: true, abortedReaderId: activeUpload.readerId });
  });

  // ---- Live status of current upload --------------------------------------
  //
  // Polls cheaply (every second is fine). Returns inProgress:false if nothing
  // is running, otherwise a snapshot of the most recent progress event plus
  // elapsed/ETA. Used by the flash-with-progress.sh script and the wizard UI.
  //
  app.get('/api/osdp/firmware-status', (_req, res) => {
    if (!activeUpload) {
      return res.json({ inProgress: false });
    }
    const now      = Date.now();
    const elapsed  = now - activeUpload.startedAt;
    const prog     = activeUpload.lastProgress;
    const status   = activeUpload.lastStatus;

    // Pre-fragment phase: no progress event yet (still in setup / re-sync POLL)
    if (!prog) {
      return res.json({
        inProgress:     true,
        readerId:       activeUpload.readerId,
        reader:         activeUpload.reader,
        port:           activeUpload.port,
        baud:           activeUpload.baud,
        address:        activeUpload.address,
        filename:       activeUpload.filename,
        startedAt:      activeUpload.startedAt,
        elapsedMs:      elapsed,
        phase:          'initializing',
        fragment:       0,
        totalFragments: null,
        bytesSent:      0,
        totalBytes:     activeUpload.totalBytes,
        percent:        0,
        lastStatusMsg:  status ? status.message : null,
        etaMs:          null,
      });
    }

    // Estimate ETA based on overall bytes-per-ms rate
    let etaMs = null;
    if (prog.bytesSent > 0 && elapsed > 0 && prog.totalBytes > prog.bytesSent) {
      const ratePerMs = prog.bytesSent / elapsed;
      etaMs = Math.round((prog.totalBytes - prog.bytesSent) / ratePerMs);
    }

    return res.json({
      inProgress:     true,
      readerId:       activeUpload.readerId,
      reader:         activeUpload.reader,
      port:           activeUpload.port,
      baud:           activeUpload.baud,
      address:        activeUpload.address,
      filename:       activeUpload.filename,
      startedAt:      activeUpload.startedAt,
      elapsedMs:      elapsed,
      phase:          prog.phase || 'transfer',
      fragment:       prog.fragment,
      totalFragments: prog.totalFragments,
      bytesSent:      prog.bytesSent,
      totalBytes:     prog.totalBytes,
      percent:        prog.percent,
      ftStatus:       prog.ftStatus,
      ftDelay:        prog.ftDelay,
      lastStatusMsg:  status ? status.message : null,
      etaMs,
    });
  });

  // ---- Scan a port for OSDP devices --------------------------------------
  //
  // Body: { port: "ttyACM0"|"/dev/ttyACM0", baud?: 9600, fromAddr?: 0, toAddr?: 15 }
  // Returns per-address probe results (replied/silent/error).
  //
  // Releases the port from OSDPManager during the scan, restores it after.
  // Refuses if a firmware upload is currently active on the same port.
  //
  app.post('/api/osdp/firmware-scan', express.json(), async (req, res) => {
    const body = req.body || {};
    const portPath = normalizePort(body.port);
    if (!portPath) return res.status(400).json({ success: false, error: 'port is required' });
    const baudRate = parseBaud(body.baud);
    const fromAddr = body.fromAddr != null ? Number(body.fromAddr) : 0;
    const toAddr   = body.toAddr   != null ? Number(body.toAddr)   : 15;
    if (!Number.isInteger(fromAddr) || fromAddr < 0 || fromAddr > 0x7E ||
        !Number.isInteger(toAddr)   || toAddr   < 0 || toAddr   > 0x7E ||
        toAddr < fromAddr) {
      return res.status(400).json({ success: false, error: 'fromAddr/toAddr out of range (0..126, fromAddr ≤ toAddr)' });
    }
    if (activeUpload) {
      return res.status(409).json({ success: false, error: 'A firmware upload is in progress' });
    }

    let portReleased = false;
    let restoreBaud  = baudRate;
    try {
      const rel = await releaseEmulatorPort(osdpManager, portPath);
      portReleased = rel.wasOwned;
      if (rel.baudRate) restoreBaud = rel.baudRate;
    } catch (e) {
      return res.status(500).json({ success: false, error: `Failed to release port: ${e.message}` });
    }

    const scanner = new OSDPFirmwareScanner({ portPath, baudRate });
    try {
      await scanner.open();
      const results = await scanner.scan({ fromAddr, toAddr });
      const replyCount = results.filter(r => r.replied).length;
      return res.json({
        success: true,
        port:    portPath,
        baud:    baudRate,
        fromAddr, toAddr,
        replyCount,
        results,
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    } finally {
      try { await scanner.close(); } catch (_) {}
      if (portReleased) {
        try {
          await new Promise(r => setTimeout(r, 200));
          await reopenEmulatorPort(osdpManager, portPath, restoreBaud);
        } catch (e) {
          console.warn(`[OSDP-FW] Could not reopen ${portPath} after scan: ${e.message}`);
        }
      }
    }
  });

  // ---- Identify a single reader ------------------------------------------
  //
  // Body: { port, baud?, address }
  // Returns parsed PDID + PDCAP. Quick (~1s, sends two commands).
  //
  app.post('/api/osdp/firmware-identify', express.json(), async (req, res) => {
    const body = req.body || {};
    const portPath = normalizePort(body.port);
    const address  = parseAddress(body.address);
    if (!portPath)         return res.status(400).json({ success: false, error: 'port is required' });
    if (address == null)   return res.status(400).json({ success: false, error: 'address is required (0..126)' });
    const baudRate = parseBaud(body.baud);
    if (activeUpload) {
      return res.status(409).json({ success: false, error: 'A firmware upload is in progress' });
    }

    let portReleased = false;
    let restoreBaud  = baudRate;
    try {
      const rel = await releaseEmulatorPort(osdpManager, portPath);
      portReleased = rel.wasOwned;
      if (rel.baudRate) restoreBaud = rel.baudRate;
    } catch (e) {
      return res.status(500).json({ success: false, error: `Failed to release port: ${e.message}` });
    }

    const ider = new OSDPFirmwareIdentifier({ portPath, baudRate, address });
    try {
      await ider.open();
      const info = await ider.identify();
      // Hint whether OSDPManager already has an SCBK configured for this reader/address —
      // used by the wizard's secure-channel key-source selector.
      let scbkConfigured = false;
      try {
        if (osdpManager && typeof osdpManager.getReaders === 'function') {
          const match = osdpManager.getReaders().find(r =>
            r.serialPort === portPath && (r.address & 0x7F) === address);
          if (match && match.scbk) scbkConfigured = true;
        }
      } catch (_) {}

      return res.json({
        success: true,
        port:    portPath,
        baud:    baudRate,
        address,
        ...info,
        scbkConfigured,
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    } finally {
      try { await ider.close(); } catch (_) {}
      if (portReleased) {
        try {
          await new Promise(r => setTimeout(r, 200));
          await reopenEmulatorPort(osdpManager, portPath, restoreBaud);
        } catch (e) {
          console.warn(`[OSDP-FW] Could not reopen ${portPath} after identify: ${e.message}`);
        }
      }
    }
  });

  // ---- Firmware library: list -------------------------------------------
  app.get('/api/osdp/firmware-library', async (_req, res) => {
    try {
      const entries = await readLibraryIndex();
      // Strip absolute paths in case anyone exported the index
      const sanitized = entries.map(e => ({
        id:         e.id,
        filename:   e.filename,
        model:      e.model || null,
        version:    e.version || null,
        sizeBytes:  e.sizeBytes,
        sha256:     e.sha256,
        approvedAt: e.approvedAt || null,
        approvedBy: e.approvedBy || null,
        notes:      e.notes || null,
        addedAt:    e.addedAt,
      }));
      res.json({ success: true, entries: sanitized });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ---- Firmware library: add --------------------------------------------
  const libUploadMw = (req, res, next) => {
    upload.single('firmware')(req, res, err => {
      if (err) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ success: false, error: err.message || String(err) });
      }
      next();
    });
  };

  app.post('/api/osdp/firmware-library', libUploadMw, async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No firmware file provided' });
    try {
      await ensureLibraryDir();
      const sha = await sha256File(req.file.path);

      const entries = await readLibraryIndex();
      const existing = entries.find(e => e.sha256 === sha);
      if (existing) {
        await unlinkSilently(req.file.path);
        return res.status(409).json({ success: false, error: 'Identical firmware already in library', existingId: existing.id });
      }

      const id = `fw_${Date.now()}_${sha.slice(0, 8)}`;
      const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalPath = path.join(LIBRARY_DIR, `${id}__${safeName}`);
      await fsp.rename(req.file.path, finalPath);

      const meta = (() => { try { return JSON.parse(req.body.metadata || '{}'); } catch { return {}; } })();
      const entry = {
        id,
        filename:   req.file.originalname,
        storedPath: finalPath,
        sizeBytes:  req.file.size,
        sha256:     sha,
        addedAt:    new Date().toISOString(),
        model:      meta.model || null,
        version:    meta.version || null,
        approvedAt: meta.approvedAt || null,
        approvedBy: meta.approvedBy || null,
        notes:      meta.notes || null,
      };
      entries.push(entry);
      await writeLibraryIndex(entries);

      res.json({ success: true, entry: { ...entry, storedPath: undefined } });
    } catch (e) {
      await unlinkSilently(req.file && req.file.path);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ---- Firmware library: delete -----------------------------------------
  app.delete('/api/osdp/firmware-library/:id', async (req, res) => {
    try {
      const entries = await readLibraryIndex();
      const idx = entries.findIndex(e => e.id === req.params.id);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
      const [removed] = entries.splice(idx, 1);
      if (removed.storedPath) await unlinkSilently(removed.storedPath);
      await writeLibraryIndex(entries);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ---- Firmware history --------------------------------------------------
  app.get('/api/osdp/firmware-history', async (req, res) => {
    try {
      const list = await readHistory();
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), HISTORY_MAX);
      res.json({ success: true, entries: list.slice(0, limit), total: list.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // NOTE: /api/osdp/capture/:readerId and /api/osdp/transfer/:readerId are
  // intentionally NOT mounted here. server.js already defines
  // /api/osdp/capture/enable|disable|packets|clear for packet-capture mode;
  // mounting a /:readerId route here would shadow those (Express matches by
  // registration order, not specificity).

  console.log('[OSDP-FW] Firmware routes mounted: scan, identify, library, history, upload, abort, status');
};
