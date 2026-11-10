// AETHER OSDP Academy — manufacturer-extension decoder (MFG 0x80 / MFGREP 0x90).
//
// Decodes vendor DATA only through a documented contract bundle. The rule that
// governs everything here: never invent meaning. A byte that no field documents
// is returned in `unknown` (raw, with its offsets); a value a schema does not
// label is reported as unknown and flagged; a reserved bit that is set stays
// visible and flagged; a state whose validity bit is clear is "Not applicable",
// never "Normal".
//
// OFFSETS ARE DATA-RELATIVE. Field offsets count from the first DATA byte, i.e.
// the byte right after the command/reply code: DATA[0..2] = vendor code (wire
// order), DATA[3] = subcommand, fields start at DATA[4]. Use frameOffset() to
// map a DATA offset to a full-frame offset (SOM = 0) for highlighting; it
// accounts for a security block when one is present.
//
// Pure data in, data out: no DOM, no network, schemas are never executed.

import { parse, hex } from './protocol.mjs?v=198dc99a';

export const STATE4 = ['Normal', 'Active', 'Trouble', 'Shorted'];
export const KINDS = ['request', 'reply', 'event'];
export const ENCODINGS = ['uint', 'int', 'hex', 'enum', 'bits', 'state4'];
export const FLAGS = ['reserved-bit-set', 'inferred', 'not-applicable', 'unknown-enum', 'out-of-range'];
const MFG = 0x80, MFGREP = 0x90, PIVDATAR = 0x80;
const CODE_FOR = { request: MFG, reply: MFGREP, event: MFGREP };
const isStr = (s) => typeof s === 'string' && s.trim() !== '';
const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const h2 = (n) => '0x' + (n & 255).toString(16).padStart(2, '0').toUpperCase();

// ── normalisation ──────────────────────────────────────────────────────────
const isLegacy = (s) => s && !Array.isArray(s.schemas) && s.requestLength !== undefined && s.kind === undefined;
const META = ['name', 'vendorHex', 'model', 'firmware', 'document', 'fictional', 'notes', 'enums'];

/**
 * Bring any accepted input into bundle shape:
 *  - a contract bundle { …, schemas: [...] } is returned as is (shallow copy);
 *  - a legacy app.mjs request schema { …, subcommand, requestLength, fields } becomes
 *    a one-schema bundle with kind 'request', code 0x80, length = requestLength;
 *  - a single new-style schema carrying its own vendor metadata becomes a one-schema bundle.
 */
export function normalizeContract(c) {
  if (!c || typeof c !== 'object') return null;
  if (Array.isArray(c.schemas)) return { ...c, legacy: false };
  const meta = Object.fromEntries(META.filter((k) => c[k] !== undefined && k !== 'notes').map((k) => [k, c[k]]));
  if (isLegacy(c)) {
    return { ...meta, legacy: true, schemas: [{ name: c.name, kind: 'request', code: MFG, subcommand: c.subcommand, length: c.requestLength,
      fields: c.fields, notes: c.notes }] };
  }
  return { ...meta, legacy: false, schemas: [{ ...c }] };
}

const enumTable = (bundle, f) => (typeof f.enum === 'string' ? bundle.enums?.[f.enum] : f.enum);
const enumLabel = (table, v) => {
  if (!table || typeof table !== 'object') return null;
  for (const k of [String(v), h2(v), '0x' + v.toString(16), '0x' + v.toString(16).toUpperCase()]) if (table[k] != null) return String(table[k]);
  return null;
};
const fieldBytes = (f) => Array.from({ length: f.width }, (_, i) => f.offset + i);
const bitMask = (b) => (b.mask != null ? b.mask : 2 ** b.bit);

// ── validation ─────────────────────────────────────────────────────────────
/** Check a contract bundle (or a legacy request schema). Never throws. */
export function validateContract(c) {
  const errors = [], warnings = [];
  const b = normalizeContract(c);
  if (!b) return { ok: false, errors: ['Contract must be an object'], warnings };
  for (const k of ['name', 'model', 'firmware', 'document']) if (!isStr(b[k])) errors.push(`Contract metadata "${k}" is required (non-empty text)`);
  if (typeof b.vendorHex !== 'string' || !/^[0-9a-f]{6}$/i.test(b.vendorHex)) errors.push('vendorHex must be exactly 6 hex digits (the 3 vendor bytes in wire order)');
  if (b.enums != null && (typeof b.enums !== 'object' || Array.isArray(b.enums))) errors.push('enums must be an object of { name: { value: label } }');
  if (!Array.isArray(b.schemas) || !b.schemas.length) { errors.push('A contract needs at least one schema'); return { ok: false, errors, warnings }; }
  if (b.legacy) warnings.push('Legacy request-only schema: treated as kind "request", code 0x80, length = requestLength');
  if (b.fictional) warnings.push('Fictional contract: for simulation and teaching only, not a real product');
  const seen = new Map();
  b.schemas.forEach((s, si) => {
    const where = `Schema ${si + 1}${isStr(s?.name) ? ` "${s.name}"` : ''}`;
    if (!s || typeof s !== 'object') { errors.push(`${where}: must be an object`); return; }
    if (!isStr(s.name)) errors.push(`${where}: name is required`);
    if (!KINDS.includes(s.kind)) errors.push(`${where}: kind must be request, reply or event`);
    const want = CODE_FOR[s.kind];
    if (s.code === undefined) { if (want != null) warnings.push(`${where}: code missing, assumed ${h2(want)}`); }
    else if (want != null && s.code !== want) errors.push(`${where}: a ${s.kind} schema must use code ${h2(want)} (${want === MFG ? 'MFG command' : 'MFGREP reply'}), not ${typeof s.code === 'number' ? h2(s.code) : String(s.code)}`);
    if (!isInt(s.subcommand, 0, 255)) errors.push(`${where}: subcommand must be an integer 0–255`);
    if (!isInt(s.length, 4, 1440)) errors.push(`${where}: length must be an integer ≥ 4 (exact DATA length incl. vendor bytes and subcommand)`);
    if (!Array.isArray(s.fields)) { errors.push(`${where}: fields must be an array`); return; }
    if (!s.fields.length) warnings.push(`${where}: no fields documented — every byte after the subcommand will be shown as undocumented`);
    const key = `${CODE_FOR[s.kind]}:${s.subcommand}:${s.length}`;
    if (seen.has(key)) errors.push(`${where}: same direction, subcommand and length as schema ${seen.get(key) + 1} — a frame could not be matched unambiguously`);
    else seen.set(key, si);
    const names = new Map(), owner = new Map();
    s.fields.forEach((f, fi) => {
      const fw = `${where}, field ${fi + 1}${isStr(f?.name) ? ` "${f.name}"` : ''}`;
      if (!f || typeof f !== 'object') { errors.push(`${fw}: must be an object`); return; }
      if (!isStr(f.name)) errors.push(`${fw}: name is required`);
      else if (names.has(f.name)) errors.push(`${fw}: duplicate field name`);
      else names.set(f.name, f);
      const posOk = isInt(f.offset, 4, 1439) && isInt(f.width, 1, 4);
      if (!isInt(f.offset, 0, 1439)) errors.push(`${fw}: offset must be a non-negative integer (DATA-relative)`);
      else if (f.offset < 4) errors.push(`${fw}: offset ${f.offset} is inside the vendor code/subcommand; DATA-relative field offsets start at 4`);
      if (!isInt(f.width, 1, 4)) errors.push(`${fw}: width must be 1–4`);
      if (posOk && isInt(s.length, 4, 1440) && f.offset + f.width > s.length) errors.push(`${fw}: bytes ${f.offset}–${f.offset + f.width - 1} run past the schema length ${s.length}`);
      if (!ENCODINGS.includes(f.encoding)) errors.push(`${fw}: unknown encoding "${f.encoding}" (use ${ENCODINGS.join(', ')})`);
      if (f.endian !== undefined && !['little', 'big'].includes(f.endian)) errors.push(`${fw}: endian must be "little" or "big"`);
      if (f.scale !== undefined && (typeof f.scale !== 'number' || !Number.isFinite(f.scale) || f.scale === 0)) errors.push(`${fw}: scale must be a non-zero number`);
      if (f.scale !== undefined && !['uint', 'int'].includes(f.encoding)) warnings.push(`${fw}: scale only applies to uint/int and is ignored`);
      const bitsMax = isInt(f.width, 1, 4) ? 2 ** (f.width * 8) - 1 : 0xffffffff;
      if (f.encoding === 'enum') {
        const t = enumTable(b, f);
        if (f.enum == null) errors.push(`${fw}: enum encoding needs an "enum" table or the name of a bundle enum`);
        else if (!t || typeof t !== 'object') errors.push(`${fw}: enum "${typeof f.enum === 'string' ? f.enum : '(inline)'}" does not resolve`);
      } else if (f.enum != null) warnings.push(`${fw}: enum is ignored for encoding "${f.encoding}"`);
      if (f.encoding === 'bits') {
        if (!Array.isArray(f.bits)) errors.push(`${fw}: bits encoding needs a "bits" array (may be empty)`);
        else for (const bt of f.bits) {
          if (!bt || !isStr(bt.name)) errors.push(`${fw}: every bit needs a name`);
          if (!isInt(bt?.bit, 0, (f.width || 4) * 8 - 1)) errors.push(`${fw}: bit ${bt?.bit} is outside a ${f.width}-byte field`);
          else if (bt.mask != null && (!isInt(bt.mask, 1, bitsMax) || !(bt.mask & 2 ** bt.bit))) errors.push(`${fw}: mask for "${bt.name}" must fit the field and include bit ${bt.bit}`);
        }
        if (f.reservedMask != null) {
          if (!isInt(f.reservedMask, 0, bitsMax)) errors.push(`${fw}: reservedMask must fit within ${f.width} byte(s)`);
          else if (Array.isArray(f.bits)) for (const bt of f.bits) if (isInt(bt?.bit, 0, 31) && f.reservedMask & bitMask(bt)) errors.push(`${fw}: bit "${bt.name}" is also in reservedMask`);
        }
      } else if (f.bits != null || f.reservedMask != null) warnings.push(`${fw}: bits/reservedMask are ignored for encoding "${f.encoding}"`);
      if (f.encoding === 'state4' && f.width !== 1) warnings.push(`${fw}: a four-state value is normally one byte`);
      if (f.indexLabels != null && (typeof f.indexLabels !== 'object' || !isStr(f.indexLabels.field) || typeof f.indexLabels.map !== 'object')) errors.push(`${fw}: indexLabels must be { field, map: { selectorValue: [labels] } }`);
      if (posOk) for (const i of fieldBytes(f)) {
        const o = owner.get(i);
        if (o && !(isStr(o.alias) && o.alias === f.alias)) errors.push(`${fw}: overlaps "${o.name}" at DATA[${i}] (overlap is only allowed when both declare the same alias group)`);
        else if (!o) owner.set(i, f);
      }
      if (f.inferred) warnings.push(`${fw}: offset is inferred from an example, not stated by the contract`);
    });
    // cross-field references (after all names are known)
    for (const f of s.fields) {
      if (!f || typeof f !== 'object') continue;
      const fw = `${where}, field "${f.name}"`;
      if (f.validity != null) {
        const v = names.get(f.validity.field);
        if (!v) errors.push(`${fw}: validity refers to unknown field "${f.validity.field}"`);
        else if (v.encoding !== 'bits') errors.push(`${fw}: validity field "${v.name}" must have encoding "bits"`);
        else if (!isInt(f.validity.bit, 0, (v.width || 1) * 8 - 1)) errors.push(`${fw}: validity bit ${f.validity.bit} is outside "${v.name}"`);
        else if (v.reservedMask != null && v.reservedMask & 2 ** f.validity.bit) errors.push(`${fw}: validity bit ${f.validity.bit} is reserved in "${v.name}"`);
        if (f.encoding !== 'state4') warnings.push(`${fw}: validity is only applied to state4 fields`);
      }
      if (f.indexLabels?.field && !names.has(f.indexLabels.field)) errors.push(`${fw}: indexLabels refers to unknown field "${f.indexLabels.field}"`);
    }
  });
  return { ok: !errors.length, errors, warnings };
}

// ── offsets ────────────────────────────────────────────────────────────────
/**
 * Map a DATA-relative offset to the full-frame offset (SOM = 0) of a parse()
 * result. DATA starts right after the code byte, so this is cmdOffset + 1 + dataOffset;
 * cmdOffset already accounts for a security block. A leading 0xFF mark is not counted.
 */
export function frameOffset(parsed, dataOffset) {
  if (!parsed || !Number.isInteger(parsed.cmdOffset)) throw TypeError('frameOffset needs a parse() result');
  if (!Number.isInteger(dataOffset) || dataOffset < 0) throw RangeError('DATA offset must be a non-negative integer');
  return parsed.cmdOffset + 1 + dataOffset;
}

// ── field rendering ────────────────────────────────────────────────────────
const readUint = (bytes, endian) => (endian === 'big' ? bytes : [...bytes].reverse()).reduce((a, x) => a * 256 + x, 0);
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(+n.toPrecision(12)));
function withUnit(raw, f) {
  if (f.scale === undefined || f.scale === 1) return `${fmtNum(raw)}${f.unit ? ' ' + f.unit : ''}`;
  return `${fmtNum(raw * f.scale)}${f.unit ? ' ' + f.unit : ''} (raw ${raw} × ${f.scale})`;
}

function renderField(f, data, schema, bundle, parsed) {
  const raw = data.slice(f.offset, f.offset + f.width);
  const flags = [], notes = [];
  const endian = f.endian || 'little';
  const u = readUint(raw, endian);
  let value = u, display;
  if (f.inferred) { flags.push('inferred'); notes.push('Offset inferred from an example, not stated by the contract'); }
  switch (f.encoding) {
    case 'hex': value = hex(raw); display = value; break;
    case 'uint': display = withUnit(u, f); value = f.scale !== undefined ? u * f.scale : u; break;
    case 'int': {
      const bits = f.width * 8, s = u >= 2 ** (bits - 1) ? u - 2 ** bits : u;
      display = withUnit(s, f); value = f.scale !== undefined ? s * f.scale : s; break;
    }
    case 'enum': {
      const lab = enumLabel(enumTable(bundle, f), u);
      if (lab == null) { flags.push('unknown-enum'); display = `unknown value ${u}`; }
      else display = lab;
      break;
    }
    case 'bits': {
      const named = (f.bits || []), parts = [];
      let covered = 0;
      for (const bt of named) {
        const m = bitMask(bt); covered |= m;
        const part = (u & m) >>> bt.bit;
        if (bt.mask != null && bt.mask !== 2 ** bt.bit) parts.push(`${bt.name} = ${part}`);
        else if (part) parts.push(bt.name);
      }
      const reserved = (f.reservedMask || 0);
      const set = [];
      for (let i = 0; i < f.width * 8; i++) if (u & 2 ** i) set.push(i);
      const bad = set.filter((i) => reserved & 2 ** i || !(covered & 2 ** i));
      for (const i of bad) parts.push(`bit ${i} (${reserved & 2 ** i ? 'reserved' : 'undocumented'}, set)`);
      if (bad.length) { flags.push('reserved-bit-set'); notes.push(`Bit(s) ${bad.join(', ')} set but reserved or undocumented — kept visible, not cleared`); }
      value = { raw: u, set, names: named.filter((bt) => u & bitMask(bt)).map((bt) => bt.name) };
      display = parts.length ? parts.join(', ') : 'none set';
      break;
    }
    case 'state4': {
      value = u <= 3 ? STATE4[u] : null;
      if (u > 3) flags.push('out-of-range');
      if (f.validity) {
        const vf = schema.fields.find((x) => x.name === f.validity.field);
        const vraw = readUint(data.slice(vf.offset, vf.offset + vf.width), vf.endian || 'little');
        if (vf.inferred) notes.push(`Applicability comes from "${vf.name}", whose offset is inferred`);
        if (!(vraw & 2 ** f.validity.bit)) {
          flags.push('not-applicable'); value = null;
          display = 'Not applicable (validity clear)';
          notes.push(`"${vf.name}" bit ${f.validity.bit} is clear, so raw byte ${h2(u)} must be ignored — it is not a Normal reading`);
          break;
        }
      }
      display = u <= 3 ? STATE4[u] : `Out of range (${u}; only 0–3 are defined)`;
      break;
    }
  }
  if (f.indexLabels && ['uint', 'int'].includes(f.encoding)) {
    const sel = schema.fields.find((x) => x.name === f.indexLabels.field);
    const sv = readUint(data.slice(sel.offset, sel.offset + sel.width), sel.endian || 'little');
    const list = f.indexLabels.map[String(sv)];
    if (!Array.isArray(list)) display += ` (no label: "${sel.name}" value ${sv} is not documented)`;
    else if (value >= 0 && value < list.length && Number.isInteger(value)) display = `${list[value]} (index ${value})`;
    else { flags.push('out-of-range'); display += ` (outside the documented range 0–${list.length - 1} for this source)`; }
  }
  if (f.reservedZero && raw.some((x) => x !== 0) && !flags.includes('reserved-bit-set')) {
    flags.push('reserved-bit-set'); notes.push('Documented as reserved (shall be zero) but carries a non-zero value');
  }
  return { name: f.name, dataOffset: f.offset, width: f.width, frameOffsets: raw.map((_, i) => frameOffset(parsed, f.offset + i)),
    raw: hex(raw), value, display, flags, encoding: f.encoding, unit: f.unit, description: f.description, notes };
}

// ── decode ─────────────────────────────────────────────────────────────────
const unknownOf = (parsed, data, from, covered = new Set()) => {
  const out = [];
  for (let i = from; i < data.length; i++) if (!covered.has(i)) out.push({ dataOffset: i, frameOffset: frameOffset(parsed, i), raw: hex([data[i]]) });
  return out;
};
const result = (status, extra) => ({ status, schema: null, reason: '', rows: [], unknown: [], notes: [], ...extra });

/**
 * Decode an MFG / MFGREP frame against a contract bundle (or legacy schema).
 * frame: hex string, byte array or a parse() result.
 * scope: { model, firmware } — what the user says the device is. Omitted parts are noted, not assumed.
 * Throws only if the contract itself is invalid (see validateContract).
 */
export function decodeVendor(frame, contractOrSchema, scope) {
  const v = validateContract(contractOrSchema);
  if (!v.ok) throw Error('Contract is invalid: ' + v.errors.join('; '));
  const bundle = normalizeContract(contractOrSchema);
  let p;
  try { p = frame && typeof frame === 'object' && !Array.isArray(frame) && !ArrayBuffer.isView(frame) && Array.isArray(frame.b) ? frame : parse(frame); }
  catch (e) { return result('bad-frame', { reason: `Not a parseable OSDP frame: ${e.message}` }); }
  const notes = [];
  if (!p.ok || p.issues?.length) notes.push(`Integrity failed: ${p.issues?.join('; ') || 'check bytes do not match'}. The bytes below are shown as received and may be corrupt.`);
  if (p.encrypted) return result('bad-frame', { reason: 'DATA is encrypted (secure channel SCS_17/18). Ciphertext cannot be decoded without the session keys; no vendor bytes are shown.', notes });
  if (p.authenticated) notes.push('Frame carries a secure-channel MAC; this training tool does not verify MACs.');
  const data = p.payload;
  const isMfg = !p.reply && p.command === MFG, isMfgRep = p.reply && p.command === MFGREP;
  if (!isMfg && !isMfgRep) {
    const reason = p.reply && p.command === PIVDATAR ? 'Reply code 0x80 is osdp_PIVDATAR (PIV data), not MFG — 0x80 means MFG only in the command direction. Vendor replies use MFGREP 0x90.'
      : !p.reply && p.command === MFGREP ? 'Command code 0x90 is not MFGREP — 0x90 is a manufacturer reply only in the reply direction (ADDR bit 7 set).'
      : `${p.reply ? 'Reply' : 'Command'} ${h2(p.command)} (${p.name}) is not a manufacturer message. Only MFG (command 0x80) and MFGREP (reply 0x90) carry vendor data.`;
    return result('not-vendor', { reason, notes });
  }
  const msg = isMfg ? 'MFG command' : 'MFGREP reply';
  if (data.length < 4) return result('bad-frame', { reason: `${msg} DATA has ${data.length} byte(s); it must carry at least the 3 vendor bytes and a subcommand.`, notes, unknown: unknownOf(p, data, 0) });
  const vendor = hex(data.slice(0, 3)).replace(/ /g, '');
  const header = { vendorHex: vendor, subcommand: data[3], vendorFrameOffsets: [0, 1, 2].map((i) => frameOffset(p, i)), subcommandFrameOffset: frameOffset(p, 3) };
  const opaque = { notes, header, unknown: unknownOf(p, data, 0) };
  if (vendor !== bundle.vendorHex.toUpperCase()) return result('no-match', { ...opaque, reason: `Vendor bytes ${vendor} do not match this contract (${bundle.vendorHex.toUpperCase()}). The payload stays opaque.` });
  if (bundle.fictional) notes.push('Fictional training contract — simulation only, not a real product.');
  const kinds = isMfg ? ['request'] : ['reply', 'event'];
  const candidates = bundle.schemas.filter((s) => kinds.includes(s.kind));
  if (!candidates.length) return result('no-match', { ...opaque, reason: `This is an ${msg}, but the contract documents no ${kinds.join('/')} schemas.` });
  // scope: the contract applies only to the exact model and firmware it names
  const sc = scope || {};
  const mism = [];
  if (sc.model != null && sc.model !== bundle.model) mism.push(`model "${sc.model}" ≠ "${bundle.model}"`);
  if (sc.firmware != null && sc.firmware !== bundle.firmware) mism.push(`firmware "${sc.firmware}" ≠ "${bundle.firmware}"`);
  if (mism.length) return result('out-of-scope', { ...opaque, reason: `Vendor matches, but the device is out of this contract's scope: ${mism.join('; ')}. Field meanings are withheld; raw bytes are preserved.` });
  const unstated = ['model', 'firmware'].filter((k) => sc[k] == null);
  if (unstated.length) notes.push(`Device ${unstated.join(' and ')} not stated — this decode assumes ${bundle.model} / ${bundle.firmware}. Confirm the device identity (e.g. from osdp_PDID) before relying on it.`);
  const sub = candidates.filter((s) => s.subcommand === data[3]);
  const schema = sub.find((s) => s.length === data.length);
  if (!schema) {
    const reason = sub.length ? `Subcommand ${h2(data[3])} is documented, but with DATA length ${sub.map((s) => s.length).join(' or ')}; this frame has ${data.length}. Not decoded.`
      : `Subcommand ${h2(data[3])} is not documented for ${kinds.join('/')} messages in this contract.`;
    return result('no-match', { ...opaque, reason });
  }
  const rows = schema.fields.map((f) => renderField(f, data, schema, bundle, p));
  const covered = new Set(schema.fields.flatMap(fieldBytes));
  if (schema.notes) notes.push(...[].concat(schema.notes));
  const inferred = rows.filter((r) => r.flags.includes('inferred')).length;
  if (inferred) notes.push(`${inferred} field(s) have offsets inferred from an example, not stated by the contract text.`);
  const unknown = unknownOf(p, data, 4, covered);
  if (unknown.length) notes.push(`${unknown.length} DATA byte(s) are not documented by this schema and are preserved raw.`);
  return result('decoded', { schema, reason: `Decoded with "${schema.name}" (${schema.kind}, subcommand ${h2(schema.subcommand)}, ${schema.length} DATA bytes) from ${bundle.document}.`,
    rows, unknown, notes, header, contract: { name: bundle.name, model: bundle.model, firmware: bundle.firmware, document: bundle.document, fictional: !!bundle.fictional } });
}
