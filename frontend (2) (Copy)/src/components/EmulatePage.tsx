// EmulatePage.tsx — example of how to wire the Card composer panel
// to the InteractiveReader's pocket-card feature. This is the parent
// for the consolidated OSDP "Emulate" tab (Card + Keypad + LED & Buzzer
// merged into one page). Drop into your project under src/components/.

import React, { useState } from 'react';
import type { Socket } from 'socket.io-client';
import InteractiveReader from './InteractiveReader';

interface ReaderRef { id: string; name: string; address: number }

interface EmulatePageProps {
  selectedReader: ReaderRef;
  socket?:        Socket;
  ipAddress:      string;
  onLog?:         (msg: string) => void;
}

interface CardComposition {
  format:       string;
  facilityCode: number;
  cardNumber:   number;
}

const FORMAT_OPTIONS = [
  { id: 'wiegand26',     label: 'Wiegand 26 (H10301)' },
  { id: 'wiegand34',     label: 'Wiegand 34 (H10304)' },
  { id: 'wiegand35',     label: 'HID Corporate 1000 (35-bit)' },
  { id: 'wiegand37',     label: 'Wiegand 37 (H10302)' },
];

export default function EmulatePage({ selectedReader, socket, ipAddress, onLog }: EmulatePageProps) {
  const backendUrl = `http://${ipAddress}:3001`;

  // ===== Lifted state — shared by CardPanel and InteractiveReader =====
  const [card, setCard] = useState<CardComposition>({
    format:       'wiegand26',
    facilityCode: 123,
    cardNumber:   45678,
  });

  // Single source of truth for "send the currently composed card."
  // Used by both the panel's Send button and the reader's tap zone.
  const sendCard = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/osdp/card-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          readerId: selectedReader.id,
          facility: card.facilityCode,
          card:     card.cardNumber,
          format:   card.format,
        }),
      });
      const json = await res.json();
      if (json.success) {
        onLog?.(`✓ Card sent: FC ${card.facilityCode} #${card.cardNumber} (${card.format})`);
      } else {
        onLog?.(`✗ Card send failed: ${json.error}`);
      }
    } catch (err: any) {
      onLog?.(`✗ Card send error: ${err.message}`);
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>

      {/* ===== LEFT: Card composer panel ===== */}
      <CardPanel value={card} onChange={setCard} onSend={sendCard} />

      {/* ===== MIDDLE: Keypad lives inside the reader in 'both' mode ===== */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Live reader
        </div>
        <InteractiveReader
          reader={selectedReader}
          socket={socket}
          backendUrl={backendUrl}
          mode="both"
          // ↓↓↓ The tap-to-send wiring ↓↓↓
          pocketCard={{
            format:       card.format,
            facilityCode: card.facilityCode,
            cardNumber:   card.cardNumber,
          }}
          onCardTap={sendCard}    // tap fires the same handler as the panel's Send
          // Keypad config
          keypadFormat="8bit"
          autoSendOnHash
        />
      </div>

      {/* ===== RIGHT: pre-configured test cards for quick reuse ===== */}
      <PreConfiguredCardsPanel onPick={setCard} />
    </div>
  );
}

// ===================== Card composer panel =====================
function CardPanel({
  value, onChange, onSend,
}: {
  value: CardComposition;
  onChange: (v: CardComposition) => void;
  onSend: () => void;
}) {
  const update = (patch: Partial<CardComposition>) => onChange({ ...value, ...patch });

  const randomize = () => onChange({
    ...value,
    facilityCode: Math.floor(Math.random() * 256),
    cardNumber:   Math.floor(Math.random() * 65536),
  });

  return (
    <div style={{
      background: '#0b1222', border: '1px solid #334155', borderRadius: 10,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <i className="ti ti-credit-card" style={{ color: '#22d3ee', fontSize: 18 }} aria-hidden />
        <div style={{ fontSize: 14, fontWeight: 500, color: '#fff' }}>Card</div>
      </div>

      <div>
        <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4, textTransform: 'uppercase' }}>Format</div>
        <select
          value={value.format}
          onChange={(e) => update({ format: e.target.value })}
          style={{
            width: '100%', background: '#0f172a', border: '1px solid #334155',
            color: '#cbd5e1', padding: '6px 8px', borderRadius: 6, fontSize: 12,
          }}
        >
          {FORMAT_OPTIONS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div>
          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4 }}>Facility</div>
          <input
            type="number"
            value={value.facilityCode}
            onChange={(e) => update({ facilityCode: parseInt(e.target.value, 10) || 0 })}
            style={inputStyle}
          />
        </div>
        <div>
          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4 }}>Card #</div>
          <input
            type="number"
            value={value.cardNumber}
            onChange={(e) => update({ cardNumber: parseInt(e.target.value, 10) || 0 })}
            style={inputStyle}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={randomize} style={secondaryBtn}>Random</button>
        <button onClick={() => onChange({ ...value, facilityCode: 1, cardNumber: 1 })} style={secondaryBtn}>Test</button>
      </div>

      <button
        onClick={onSend}
        disabled={!value.cardNumber}
        style={{
          background: 'rgba(34,211,238,0.20)',
          color: '#22d3ee',
          border: '1px solid rgba(34,211,238,0.40)',
          borderRadius: 8, padding: 10, fontSize: 12, fontWeight: 500,
          cursor: value.cardNumber ? 'pointer' : 'not-allowed',
          opacity: value.cardNumber ? 1 : 0.4,
        }}
      >
        Send card
      </button>

      <div style={{ fontSize: 10, color: '#475569', textAlign: 'center', marginTop: 4 }}>
        Or tap the card target on the reader →
      </div>
    </div>
  );
}

// ===================== Pre-configured cards quick-pick =====================
// Static presets baked into the UI for fast testing. Not user-editable —
// to add to this list, edit the PRECONFIGURED array below.
function PreConfiguredCardsPanel({ onPick }: { onPick: (c: CardComposition) => void }) {
  const PRECONFIGURED: Array<{ label: string } & CardComposition> = [
    { label: 'Admin badge',    format: 'wiegand26', facilityCode: 1,   cardNumber: 1     },
    { label: 'Test card 1234', format: 'wiegand26', facilityCode: 100, cardNumber: 1234  },
    { label: 'Visitor #5050',  format: 'wiegand26', facilityCode: 200, cardNumber: 5050  },
  ];
  return (
    <div style={{
      background: '#0b1222', border: '1px solid #334155', borderRadius: 10,
      padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Pre-configured cards
      </div>
      {PRECONFIGURED.map((p, i) => (
        <button
          key={i}
          onClick={() => onPick({ format: p.format, facilityCode: p.facilityCode, cardNumber: p.cardNumber })}
          style={{
            background: '#1e293b', border: '1px solid #334155', color: '#cbd5e1',
            borderRadius: 6, padding: '8px 10px', fontSize: 12, textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <div style={{ fontWeight: 500 }}>{p.label}</div>
          <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'monospace' }}>
            FC {p.facilityCode} · #{p.cardNumber} · {p.format}
          </div>
        </button>
      ))}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  background: '#0f172a', border: '1px solid #334155',
  color: '#cbd5e1', padding: '6px 8px', borderRadius: 6, fontSize: 12,
};

const secondaryBtn: React.CSSProperties = {
  flex: 1, background: '#1e293b', border: '1px solid #334155',
  color: '#94a3b8', borderRadius: 6, padding: '6px 0', fontSize: 11,
  cursor: 'pointer',
};
