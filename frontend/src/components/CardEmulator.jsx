import React, { useMemo, useState } from 'react';

const PRESETS = [
  { id: 'wiegand26',   label: 'Wiegand 26 (8+16)',           bitCount: 26, fields: ['facility','card'] },
  { id: 'wiegand30',   label: 'Wiegand 30 (10+20)',          bitCount: 30, fields: ['facility','card'] },
  { id: 'wiegand32',   label: 'Wiegand 32 (16+16)',          bitCount: 32, fields: ['facility','card'] },
  { id: 'wiegand34',   label: 'Wiegand 34 (16+16)',          bitCount: 34, fields: ['facility','card'] },
  { id: 'wiegand37',   label: 'Wiegand 37 / H10302 (16+19)', bitCount: 37, fields: ['facility','card'] },
  { id: 'h10304_37',   label: 'HID C1K 37 (15+20)',          bitCount: 37, fields: ['facility','card'] },
  { id: 'hidc1000_35', label: 'HID C1K 35 (12+20)',          bitCount: 35, fields: ['facility','card'] },
  { id: 'stid_40',     label: 'STid 40 (16+24)',             bitCount: 40, fields: ['facility','card'] },
  { id: 'hid_48',      label: 'HID 48 (16+32)',              bitCount: 48, fields: ['facility','card'] },
  { id: 'seos_64',     label: 'SEOS 64 (raw 64b)',           bitCount: 64, fields: ['facility','card'] },
  { id: 'fascn_75',    label: 'FASC-N 75 (raw)',             bitCount: 75, fields: ['raw','bitCount'] },
  { id: 'custom',      label: 'Custom (raw+bits)',           bitCount: 26, fields: ['raw','bitCount'] },
];

export default function CardEmulator({ readerId }) {
  const [presetId, setPresetId] = useState('wiegand26');
  const preset = useMemo(() => PRESETS.find(p => p.id === presetId), [presetId]);

  const [facility, setFacility] = useState('');
  const [card, setCard] = useState('');
  const [raw, setRaw] = useState('');
  const [bitCount, setBitCount] = useState(preset.bitCount);

  const canSend = useMemo(() => {
    if (!readerId) return false;
    if (preset.id === 'custom') return raw !== '' && bitCount > 0 && bitCount <= 64;
    if (preset.id === 'fascn_75') return raw !== '' && bitCount === 75;
    return card !== '' && (preset.fields.includes('facility') ? facility !== '' : true);
  }, [readerId, preset, facility, card, raw, bitCount]);

  const buildPayload = () => {
    if (preset.id === 'custom' || preset.id === 'fascn_75') {
      const text = String(raw).trim();
      const cardNumber = text.startsWith('0x') || text.startsWith('0X') ? BigInt(text) : BigInt(text);
      return {
        readerId,
        format: preset.id,
        bitCount: Number(bitCount),
        cardNumber: cardNumber.toString(),
      };
    }

    const fc = Number(facility || 0);
    const id = Number(card || 0);
    let bits = preset.bitCount;
    let combined;

    switch (preset.id) {
      case 'wiegand26':
        combined = BigInt((fc & 0xFF) << 16 | (id & 0xFFFF));
        break;
      case 'wiegand30':
        combined = (BigInt(fc & 0x3FF) << 20n) | BigInt(id & 0xFFFFF);
        break;
      case 'wiegand32':
      case 'wiegand34':
        combined = (BigInt(fc & 0xFFFF) << 16n) | BigInt(id & 0xFFFF);
        break;
      case 'wiegand37':
        combined = (BigInt(fc & 0xFFFF) << 19n) | BigInt(id & 0x7FFFF);
        break;
      case 'h10304_37':
        combined = (BigInt(fc & 0x7FFF) << 20n) | BigInt(id & 0xFFFFF);
        break;
      case 'hidc1000_35':
        bits = 35;
        combined = (BigInt(fc & 0xFFF) << 20n) | BigInt(id & 0xFFFFF);
        break;
      case 'stid_40':
        combined = (BigInt(fc & 0xFFFF) << 24n) | BigInt(id & 0xFFFFFF);
        break;
      case 'hid_48':
        combined = (BigInt(fc & 0xFFFF) << 32n) | (BigInt(id) & 0xFFFFFFFFn);
        break;
      case 'seos_64':
        bits = 64;
        combined = (BigInt(fc) << 32n) | (BigInt(id) & 0xFFFFFFFFn);
        break;
      default:
        combined = BigInt(id);
        break;
    }

    return {
      readerId,
      format: preset.id,
      bitCount: bits,
      facility: fc,
      card: id,
      cardNumber: combined.toString(),
    };
  };

  const sendCard = async () => {
    const payload = buildPayload();
    const r = await fetch('/api/osdp/card-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(`Failed: ${data?.error || r.statusText}`);
      return;
    }
    alert('Card queued (sent on next POLL).');
  };

  return (
    <div style={{ marginTop: 12, padding: 12, border: '1px dashed #aaa', borderRadius: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>Card Emulation</strong>
        <select
          value={presetId}
          onChange={(e)=>{
            const next = e.target.value;
            setPresetId(next);
            const p = PRESETS.find(x=>x.id===next);
            if (p) setBitCount(p.bitCount);
          }}
        >
          {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        {preset.fields.includes('facility') && (
          <input type="number" placeholder="Facility" value={facility} onChange={e=>setFacility(e.target.value)} style={{ width: 110 }} />
        )}
        {preset.fields.includes('card') && (
          <input type="number" placeholder="Card" value={card} onChange={e=>setCard(e.target.value)} style={{ width: 140 }} />
        )}
        {(preset.id === 'custom' || preset.id === 'fascn_75') && (
          <>
            <input type="text" placeholder="Raw value (dec or 0xHEX)" value={raw} onChange={e=>setRaw(e.target.value)} style={{ width: 220 }} />
            <input type="number" placeholder="Bits" value={bitCount} onChange={e=>setBitCount(Number(e.target.value))} style={{ width: 80 }} />
          </>
        )}

        <button onClick={sendCard} disabled={!canSend}>Send</button>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
        Facility/Card are combined according to selected preset. Custom/FASC-N accept raw + bit count.
      </div>
    </div>
  );
}

