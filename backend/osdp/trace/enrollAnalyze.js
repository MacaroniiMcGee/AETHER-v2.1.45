// enrollAnalyze.js — work out a credential's bit map from one or more live reads.
//
// Given the raw bit strings captured from a reader (all the same length), it:
//  1. matches them against the known format library (parity-aware), and
//  2. SOLVES the layout from the number printed on the card — if you tell it the
//     facility and/or card number, it finds where those values sit in the bits,
//     tests the end bits as parity, and labels FC / card / fixed. Works from a
//     SINGLE card, even for a format that isn't in the library, and
//  3. derives a bit map by diffing several cards: bits that change are the card
//     number, bits that stay constant are facility/fixed, end bits are parity.
'use strict';

// bitsThatChange across the reads (1-based positions)
function diffPositions(binaries) {
  const n = binaries[0].length;
  const changing = [];
  for (let i = 0; i < n; i++) {
    const v = binaries[0][i];
    if (binaries.some(b => b[i] !== v)) changing.push(i + 1);
  }
  return changing;
}

const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
const bit = (bits, p) => bits[p - 1] === '1' ? 1 : 0;
// BigInt value of bits[s..e] (1-based, inclusive, MSB first).
function bitsVal(bits, s, e) { let v = 0n; for (let p = s; p <= e; p++) v = (v << 1n) | (bits[p - 1] === '1' ? 1n : 0n); return v; }
function safeBig(x) { try { const s = String(x).trim(); return /^\d+$/.test(s) ? BigInt(s) : null; } catch { return null; } }

// Does the parity bit at `pbit` correctly protect `covers` in this frame?
// Even parity: covered bits plus the parity bit sum to even; odd: to odd.
const parityHolds = (bits, pbit, covers, even) => {
  const ones = covers.reduce((c, p) => c + bit(bits, p), 0) + bit(bits, pbit);
  return even ? ones % 2 === 0 : ones % 2 === 1;
};

// Detect the classic leading-even / trailing-odd parity pair and the data region
// between them. Tries the common split widths (half for 26/34-bit, whole-frame
// for the 37-bit style). Needs the guess to hold on EVERY read to be accepted.
function detectParity(binaries) {
  const n = binaries[0].length;
  const parity = []; let dataStart = 1, dataEnd = n;
  if (n >= 8) {
    const inner = n - 2;
    const widths = [...new Set([Math.floor(inner / 2), Math.ceil(inner / 2), inner])];
    for (const w of widths) { const cov = range(2, 1 + w); if (cov[cov.length - 1] < n && binaries.every(b => parityHolds(b, 1, cov, true))) { parity.push({ bit: 1, type: 'even', covers: cov }); dataStart = 2; break; } }
    for (const w of widths) { const cov = range(n - w, n - 1); if (cov[0] > 1 && binaries.every(b => parityHolds(b, n, cov, false))) { parity.push({ bit: n, type: 'odd', covers: cov }); dataEnd = n - 1; break; } }
  }
  return { parity, dataStart, dataEnd };
}

// Try to match the reads against every library format of the same length.
// `expected` (optional): {facility, card} printed on the first card — a format
// whose decode of the first read matches those numbers is a confirmed match.
function matchLibrary(binaries, formats, decodeBits, expected = null) {
  const bits = binaries[0].length;
  const cands = formats.filter(f => f.bits === bits);
  const results = [];
  for (const f of cands) {
    let parityOk = true, consistent = true;
    let fc = null, confirmed = false;
    for (let i = 0; i < binaries.length; i++) {
      const d = decodeBits(f.map, binaries[i]);
      if (!d) { consistent = false; break; }
      if (d.parityOk === false) parityOk = false;
      if (fc === null) fc = d.facility; else if (d.facility !== fc) fc = '∆';
      if (i === 0 && expected) {
        const cardOk = expected.card == null || String(d.card) === String(expected.card);
        const fcOk = expected.facility == null || String(d.facility) === String(expected.facility);
        confirmed = cardOk && fcOk;
      }
    }
    if (!consistent) continue;
    results.push({ id: f.id, name: f.name, status: f.status, parityOk, facilityConstant: fc !== '∆', confirmed });
  }
  // a confirmed match (numbers line up) wins; then parity-valid, facility-constant, verified
  results.sort((a, b) =>
    Number(b.confirmed) - Number(a.confirmed) ||
    Number(b.parityOk) - Number(a.parityOk) ||
    Number(b.facilityConstant) - Number(a.facilityConstant) ||
    (a.status === 'verified' ? -1 : 0) - (b.status === 'verified' ? -1 : 0));
  return results;
}

// ── SOLVE FROM THE NUMBER ON THE CARD ──────────────────────────────────────
// The key idea the platform relies on: you can't always read a format back from
// bits alone, but if the tech tells us the number(s) printed on the card, we can
// find WHERE that number lives in the frame — that pins the card field, the
// facility field, and (by elimination + the end bits) the parity. One card is
// enough; more cards just raise confidence.

const MAX_CARD_BITS = 48;   // card fields don't run wider than this in practice
const MAX_FC_BITS = 24;

// Score a proposed map against every read using the real decoder.
function scoreLayout(map, binaries, decodeBits, wantCard, wantFC, changing) {
  let cardOk = false, fcOk = true, parityOk = true, varies = false;
  const cardVals = new Set();
  for (let i = 0; i < binaries.length; i++) {
    const d = decodeBits(map, binaries[i]);
    if (!d) return null;
    if (d.parityOk === false) parityOk = false;
    cardVals.add(String(d.card));
    if (i === 0) {
      cardOk = String(d.card) === String(wantCard);
      fcOk = wantFC == null ? true : String(d.facility) === String(wantFC);
    }
  }
  if (binaries.length > 1) varies = cardVals.size > 1;
  const fixedBits = (map.fields || []).filter(f => f.key === 'fixed').reduce((s, f) => s + f.len, 0);
  const rank = (cardOk ? 100 : 0) + (fcOk ? 40 : 0) + (parityOk ? 20 : 0) + (varies ? 8 : 0) - fixedBits;
  return { cardOk, fcOk, parityOk, varies, fixedBits, rank };
}

function buildFields(dataStart, dataEnd, fac, card, read0) {
  const fields = [];
  const segs = [];
  if (fac) segs.push({ ...fac, key: 'facility' });
  segs.push({ ...card, key: 'card' });
  segs.sort((a, b) => a.s - b.s);
  let cur = dataStart;
  for (const seg of segs) {
    if (seg.s > cur) fields.push({ key: 'fixed', start: cur, len: seg.s - cur, value: Number(bitsVal(read0, cur, seg.s - 1) & 0xffffffffn) });
    fields.push({ key: seg.key, start: seg.s, len: seg.e - seg.s + 1 });
    cur = seg.e + 1;
  }
  if (cur <= dataEnd) fields.push({ key: 'fixed', start: cur, len: dataEnd - cur + 1, value: Number(bitsVal(read0, cur, dataEnd) & 0xffffffffn) });
  return fields;
}

// Solve within one data region: find the card field (value match), then the
// facility field (value match, if given), build + score the map.
function solveInRegion(binaries, reg, wantCard, wantFC, changing, decodeBits) {
  const read0 = binaries[0];
  const { dataStart, dataEnd, parity } = reg;
  const dataChanging = changing.filter(p => p >= dataStart && p <= dataEnd);
  let best = null;

  for (let cs = dataStart; cs <= dataEnd; cs++) {
    const ceMax = Math.min(dataEnd, cs + MAX_CARD_BITS - 1);
    for (let ce = cs; ce <= ceMax; ce++) {
      if (bitsVal(read0, cs, ce) !== wantCard) continue;
      // multi-read sanity: the card field should contain the bits that changed
      if (dataChanging.length && !(cs <= Math.min(...dataChanging) && ce >= Math.max(...dataChanging))) continue;
      const card = { s: cs, e: ce };

      const facChoices = [];
      if (wantFC != null) {
        // facility usually sits before the card; also allow after.
        for (const [lo, hi] of [[dataStart, cs - 1], [ce + 1, dataEnd]]) {
          for (let fs = lo; fs <= hi; fs++) {
            const feMax = Math.min(hi, fs + MAX_FC_BITS - 1);
            for (let fe = fs; fe <= feMax; fe++) if (bitsVal(read0, fs, fe) === wantFC) facChoices.push({ s: fs, e: fe });
          }
        }
        if (!facChoices.length) continue;   // FC given but not found around this card → not this placement
      } else {
        facChoices.push(null);
      }

      for (const fac of facChoices) {
        const fields = buildFields(dataStart, dataEnd, fac, card, read0);
        const map = { bits: read0.length, fields, parity };
        const score = scoreLayout(map, binaries, decodeBits, wantCard, wantFC, changing);
        if (score && (!best || score.rank > best.score.rank)) best = { map, score, facFound: !!fac, card, fac };
      }
    }
  }
  return best;
}

// Public: solve the layout from the printed number(s). Returns null if no card
// number was supplied or nothing plausible was found.
function solveLayout(binaries, expected, decodeBits) {
  if (!expected) return null;
  const wantCard = safeBig(expected.card);
  const wantFC = expected.facility != null && expected.facility !== '' ? safeBig(expected.facility) : null;
  if (wantCard == null) return null;   // need at least the card number to anchor on
  if (typeof decodeBits !== 'function') return null;

  const n = binaries[0].length;
  const changing = binaries.length >= 2 ? diffPositions(binaries) : [];
  // Try with the detected parity pair first, then the whole frame as a fallback.
  const regions = [];
  const det = detectParity(binaries);
  if (det.parity.length) regions.push(det);
  regions.push({ parity: [], dataStart: 1, dataEnd: n });

  const attempt = (fc) => {
    let best = null;
    for (const reg of regions) {
      const cand = solveInRegion(binaries, reg, wantCard, fc, changing, decodeBits);
      if (cand && (!best || cand.score.rank > best.score.rank)) best = cand;
    }
    return best;
  };
  const pack = (best, fcAsked, note, facilityMismatch) => {
    if (!best) return null;
    const s = best.score;
    return {
      ok: s.cardOk && (fcAsked == null || s.fcOk),
      map: best.map, facilityFound: best.facFound, parityOk: s.parityOk,
      fromCardOnly: fcAsked == null, facilityMismatch: !!facilityMismatch, note: note || null,
      reads: binaries.length,
      confidence: !s.cardOk ? 'low' : (s.parityOk && (fcAsked == null || s.fcOk)) ? 'high' : 'medium',
      fields: best.map.fields.map(f => f.key),
    };
  };

  const withFC = wantFC != null ? attempt(wantFC) : null;
  if (withFC && withFC.score.cardOk && withFC.score.fcOk) return pack(withFC, wantFC);

  // Couldn't place the facility (wrong FC, or this format carries no facility) —
  // fall back to anchoring on the card number alone so we still find the card.
  const cardOnly = attempt(null);
  if (cardOnly && cardOnly.score.cardOk) {
    if (wantFC != null) return pack(cardOnly, null,
      'Matched on the card number. The facility code you entered wasn’t found in these bits — this format may not carry a facility code, or the number differs.', true);
    return pack(cardOnly, null);
  }
  return pack(withFC || cardOnly, wantFC);   // last resort: report the best (low confidence)
}

// ── GUIDED ENROLLMENT (known numbers, several credentials) ──────────────────
// The wizard collects, per credential, the printed card number (+ optional FC)
// and 3 reads of it. With several distinct known values the card and facility
// fields become DETERMINISTIC: the card field is the only bit range that yields
// every credential's own printed number across every read. No guessing.

// Normalise the wizard payload into flat {bin, card, fc} rows + the group list.
function flattenGroups(groups) {
  const flat = [];
  const clean = [];
  for (const g of groups || []) {
    const card = safeBig(g.card);
    const fc = g.facility != null && g.facility !== '' ? safeBig(g.facility) : null;
    const bins = (g.binaries || []).filter(b => typeof b === 'string' && /^[01]+$/.test(b));
    if (card == null || !bins.length) continue;
    clean.push({ card, fc, binaries: bins });
    for (const b of bins) flat.push({ bin: b, card, fc });
  }
  return { flat, clean };
}

// Match the library: a format is "confirmed" only if it decodes EVERY read to
// that read's own printed number (and FC when given). Far stronger than one card.
function matchGroups(flat, formats, decodeBits) {
  const bits = flat[0].bin.length;
  const results = [];
  for (const f of formats.filter(x => x.bits === bits)) {
    let ok = true, parityOk = true, confirmed = true;
    for (const r of flat) {
      const d = decodeBits(f.map, r.bin);
      if (!d) { ok = false; break; }
      if (d.parityOk === false) parityOk = false;
      if (String(d.card) !== String(r.card)) confirmed = false;
      if (r.fc != null && String(d.facility) !== String(r.fc)) confirmed = false;
    }
    if (!ok) continue;
    results.push({ id: f.id, name: f.name, status: f.status, parityOk, facilityConstant: true, confirmed });
  }
  results.sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || Number(b.parityOk) - Number(a.parityOk) ||
    (a.status === 'verified' ? -1 : 0) - (b.status === 'verified' ? -1 : 0));
  return results;
}

// Deterministic field find across all known (bits → number) pairs.
function solveGroups(flat, decodeBits) {
  if (!flat.length) return null;
  const n = flat[0].bin.length;
  if (!flat.every(r => r.bin.length === n)) return null;
  const binaries = flat.map(r => r.bin);
  const haveFC = flat.some(r => r.fc != null);

  const regions = [];
  const det = detectParity(binaries);
  if (det.parity.length) regions.push(det);
  regions.push({ parity: [], dataStart: 1, dataEnd: n });

  // A [s,e] range that yields, for every read, the value stored on that read.
  const rangeYields = (s, e, key) => flat.every(r => (key === 'fc' ? r.fc == null || bitsVal(r.bin, s, e) === r.fc : bitsVal(r.bin, s, e) === r.card));

  let best = null;
  for (const reg of regions) {
    const { dataStart, dataEnd, parity } = reg;
    for (let cs = dataStart; cs <= dataEnd; cs++) {
      const ceMax = Math.min(dataEnd, cs + MAX_CARD_BITS - 1);
      for (let ce = cs; ce <= ceMax; ce++) {
        if (!rangeYields(cs, ce, 'card')) continue;
        const card = { s: cs, e: ce };
        const facChoices = [];
        if (haveFC) {
          for (const [lo, hi] of [[dataStart, cs - 1], [ce + 1, dataEnd]]) {
            for (let fs = lo; fs <= hi; fs++) {
              const feMax = Math.min(hi, fs + MAX_FC_BITS - 1);
              for (let fe = fs; fe <= feMax; fe++) if (rangeYields(fs, fe, 'fc')) facChoices.push({ s: fs, e: fe });
            }
          }
          if (!facChoices.length) continue;
        } else facChoices.push(null);
        for (const fac of facChoices) {
          const fields = buildFields(dataStart, dataEnd, fac, card, flat[0].bin);
          const map = { bits: n, fields, parity };
          // score: every read must decode to its own number
          let cardOk = true, fcOk = true, parityOk = true;
          for (const r of flat) {
            const d = decodeBits(map, r.bin); if (!d) { cardOk = false; break; }
            if (String(d.card) !== String(r.card)) cardOk = false;
            if (r.fc != null && String(d.facility) !== String(r.fc)) fcOk = false;
            if (d.parityOk === false) parityOk = false;
          }
          const fixedBits = fields.filter(f => f.key === 'fixed').reduce((s, f) => s + f.len, 0);
          const rank = (cardOk ? 100 : 0) + (fcOk ? 40 : 0) + (parityOk ? 20 : 0) - fixedBits;
          if (!best || rank > best.rank) best = { map, rank, cardOk, fcOk, parityOk, facFound: !!fac };
        }
      }
    }
  }
  if (!best) return null;
  return {
    ok: best.cardOk && best.fcOk, map: best.map, facilityFound: best.facFound, parityOk: best.parityOk,
    fromCardOnly: !haveFC, credentials: null,
    confidence: !best.cardOk ? 'low' : (best.parityOk ? 'high' : 'medium'),
    fields: best.map.fields.map(f => f.key),
  };
}

// Full guided analysis for the wizard.
function analyzeGuided(groups, formats, decodeBits) {
  const { flat, clean } = flattenGroups(groups);
  if (!flat.length) return { error: 'No captured reads with a card number.' };
  const len = flat[0].bin.length;
  if (!flat.every(r => r.bin.length === len)) return { error: 'The reads are not all the same length. Present the same type of credential each time.' };
  const binaries = flat.map(r => r.bin);
  const matches = matchGroups(flat, formats, decodeBits);
  const solved = solveGroups(flat, decodeBits);
  if (solved) solved.credentials = clean.length;
  const derived = deriveMap(binaries);
  const best = matches.find(m => m.confirmed) || matches[0] || null;
  return { bits: len, reads: flat.length, credentials: clean.length, matches, solved, derived, best };
}

// Derive a fresh bit map from the reads (no library, no printed number).
function deriveMap(binaries) {
  const n = binaries[0].length;
  const changing = diffPositions(binaries);
  const fields = [];
  let parityBits = [];
  let dataStart = 1, dataEnd = n;

  // Parity needs 2+ reads to avoid a chance match on a single frame.
  if (binaries.length >= 2) {
    const det = detectParity(binaries);
    parityBits = det.parity; dataStart = det.dataStart; dataEnd = det.dataEnd;
  }

  // Card number = the span of changing bits within the data region.
  const dataChanging = changing.filter(p => p >= dataStart && p <= dataEnd);
  if (dataChanging.length) {
    const cardLo = Math.min(...dataChanging), cardHi = Math.max(...dataChanging);
    if (cardLo > dataStart) fields.push({ key: 'facility', start: dataStart, len: cardLo - dataStart });
    fields.push({ key: 'card', start: cardLo, len: cardHi - cardLo + 1 });
    if (cardHi < dataEnd) fields.push({ key: 'fixed', start: cardHi + 1, len: dataEnd - cardHi, value: 0 });
  } else {
    fields.push({ key: 'card', start: dataStart, len: dataEnd - dataStart + 1 });
  }
  return {
    bits: n, fields, parity: parityBits,
    confidence: binaries.length >= 3 ? 'high' : binaries.length === 2 ? 'medium' : 'low',
    changingBits: changing.length,
  };
}

// Full analysis for the UI.
function analyzeReads(binaries, formats, decodeBits, expected = null) {
  if (!binaries.length) return null;
  const len = binaries[0].length;
  const sameLen = binaries.every(b => b.length === len);
  if (!sameLen) return { error: 'The reads are not all the same length. Present the same type of card.' };
  const matches = matchLibrary(binaries, formats, decodeBits, expected);
  const solved = solveLayout(binaries, expected, decodeBits);
  const derived = deriveMap(binaries);
  return { bits: len, reads: binaries.length, matches, solved, derived, best: matches[0] || null };
}

module.exports = { analyzeReads, analyzeGuided, deriveMap, matchLibrary, matchGroups, solveLayout, solveGroups, detectParity, diffPositions };
