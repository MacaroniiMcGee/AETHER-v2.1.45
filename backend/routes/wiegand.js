const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const pinRegistry = require("../lib/pinRegistry");
const bits = require("../lib/wiegandBits");
const pinmap = require("../lib/pinmap");

const router = express.Router();

function asInt(v, def=null) {
  if (v === undefined || v === null || v === "") return def;
  const n = Number.isInteger(v) ? v : parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

router.get("/config", (req, res) => {
  res.json({ ok: true, ...pinRegistry.config(), reserved: pinRegistry.listReserved() });
});

router.post("/preview", (req, res) => {
  try {
    const b = req.body || {};
    const parity = b.parity || "std";
    let frame;
    if (typeof b.rawBits === "string" && b.rawBits.trim()) {
      const data = bits.bitsFromHexOrBin(b.rawBits.trim());
      frame = bits.applyParity(data, parity, asInt(b.frameBits));
    } else {
      const format = asInt(b.format, 26);
      const { data } = bits.composeData({
        format,
        facility: asInt(b.facility,0),
        card: asInt(b.card,0),
        facilityBits: asInt(b.facilityBits, undefined),
        cardBits: asInt(b.cardBits, undefined)
      });
      frame = bits.applyParity(data, parity, asInt(b.frameBits));
    }
    return res.json({ ok:true, parity, length: frame.length, frameBits: bits.formatBits(frame) });
  } catch (e) {
    return res.status(400).json({ ok:false, error: e.message });
  }
});

router.post("/send", async (req, res) => {
  const b = req.body || {};
  try {
    let chip = pinRegistry.chip;
    let d0, d1;
    if (b.pins && (b.pins.d0Phys || b.pins.d1Phys)) {
      d0 = pinmap.toBcm(b.pins.d0Phys);
      d1 = pinmap.toBcm(b.pins.d1Phys);
    } else {
      const doorNum = asInt(b.door);
      if (!doorNum) throw new Error("Missing 'door' (1-4).");
      const door = pinRegistry.getDoor(doorNum);
      if (!door) throw new Error(`Unknown door ${doorNum}.`);
      d0 = door.d0; d1 = door.d1;
    }

    const exe = path.resolve(__dirname, "../bin/wiegand_tx");
    const pulseUs = asInt(b.pulseUs, 50);
    const spaceUs = asInt(b.spaceUs, 1000);
    const parity = (b.parity || "std");

    const args = [
      "--chip", chip,
      "--d0", String(d0),
      "--d1", String(d1),
      "--pulse-us", String(pulseUs),
      "--space-us", String(spaceUs),
      "--parity", parity
    ];

    if (typeof b.rawBits === "string" && b.rawBits.trim()) {
      args.push("--raw-bits", b.rawBits.trim());
      if (b.frameBits != null) args.push("--frame-bits", String(asInt(b.frameBits)));
    } else {
      const format = asInt(b.format, 26);
      if (![26,34,35,37,48].includes(format))
        throw new Error("format must be one of 26,34,35,37,48 or supply rawBits");
      args.push("--format", String(format));
      args.push("--facility", String(asInt(b.facility, 0)));
      args.push("--card", String(asInt(b.card, 0)));
      if (b.facilityBits != null) args.push("--facility-bits", String(asInt(b.facilityBits)));
      if (b.cardBits != null) args.push("--card-bits", String(asInt(b.cardBits)));
      if (b.frameBits != null) args.push("--frame-bits", String(asInt(b.frameBits)));
    }

    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });

    child.on("error", (err) => res.status(500).json({ ok:false, error: `spawn failed: ${err.message}` }));
    child.on("close", (code) => {
      if (code === 0) return res.json({ ok:true, pins: { d0, d1 }, args, stdout });
      res.status(422).json({ ok:false, pins: { d0, d1 }, code, args, stdout, stderr });
    });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message });
  }
});

module.exports = router;
