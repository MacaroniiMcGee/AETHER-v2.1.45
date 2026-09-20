// InteractiveWiegandReader.tsx
// Sender-only visual reader for Wiegand. Mirrors the OSDP InteractiveReader
// chrome (brick wall + brushed-metal bezel + glass keypad) but is intentionally
// NOT bidirectional — Wiegand is reader→controller only. The LED bar is local
// feedback only (idle blue / amber while TX / green ok / red err).
//
// Keypad transmission absorbs logic from the former KeypadEmulator:
//   - burst mode (4-bit / 8-bit): POST each key to /api/wiegand/raw with rawBits
//   - single-packet mode (26-bit): POST whole PIN to /api/wiegand/transmit as a card

import React, { useEffect, useRef, useState } from 'react';
import emulatorFormats from '../Readers/Emulator_Formats.json';

// ===== Brick-wall background (painted-grey, offset/staggered) =====
const BRICK_WALL_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100'>" +
  "<rect width='200' height='100' fill='#3a3a3a'/>" +
  "<rect x='2' y='2' width='96' height='28' fill='#4f4f4f' rx='1'/>" +
  "<rect x='102' y='2' width='96' height='28' fill='#4f4f4f' rx='1'/>" +
  "<rect x='-48' y='34' width='96' height='28' fill='#4f4f4f' rx='1'/>" +
  "<rect x='52' y='34' width='96' height='28' fill='#4f4f4f' rx='1'/>" +
  "<rect x='152' y='34' width='96' height='28' fill='#4f4f4f' rx='1'/>" +
  "<rect x='2' y='66' width='96' height='28' fill='#4f4f4f' rx='1'/>" +
  "<rect x='102' y='66' width='96' height='28' fill='#4f4f4f' rx='1'/>" +
  "</svg>";
const BRICK_WALL_BG =
  'url("data:image/svg+xml;utf8,' + encodeURIComponent(BRICK_WALL_SVG) + '")';

// ===== Types =====
interface PocketCard {
  format?:       string | number;
  facilityCode?: number;
  cardNumber?:   number;
}

interface WiegandReaderRef {
  name:        string;
  readerId?:   string | number;
  door?:       string;
  d0Pin?:      number;
  d1Pin?:      number;
  pulseWidth?: number;
}

interface KeypadFormatDef {
  id: string;
  name?: string;
  transmission: 'burst' | 'single';
  bitsPerKey?: number;
  bits?: number;
  hexMap?: Record<string, string>;
  keyMap?: Record<string, string>;
  facilityCodeRequired?: boolean;
  maxPin?: number;
}

interface InteractiveWiegandReaderProps {
  reader:        WiegandReaderRef;
  backendUrl:    string;
  pocketCard?:   PocketCard;
  keypadFormat?: string;
  facilityCode?: number;
  onCardTap?:    () => void;
  onCardSent?:   (card: PocketCard) => void;
  defaultFormat?: number;
}

interface RecentEntry {
  time: string;
  type: 'CARD' | 'PIN' | 'ERR';
  description: string;
}

type LedState = 'idle' | 'sending' | 'ok' | 'err';

const LED_COLOR: Record<LedState, string> = {
  idle:    '#3b82f6',
  sending: '#f59e0b',
  ok:      '#22c55e',
  err:     '#ef4444',
};

const FALLBACK_FORMATS: KeypadFormatDef[] = [
  { id: '4bit', transmission: 'burst', bitsPerKey: 4 },
  { id: '8bit', transmission: 'burst', bitsPerKey: 8 },
  { id: '26bit', transmission: 'single', bits: 26, maxPin: 999999 },
];

export default function InteractiveWiegandReader({
  reader,
  backendUrl,
  pocketCard,
  keypadFormat = '4bit',
  facilityCode = 0,
  onCardTap,
  onCardSent,
  defaultFormat = 26,
}: InteractiveWiegandReaderProps) {
  // ===== State =====
  const [ledState, setLedState]   = useState<LedState>('idle');
  const ledTimerRef               = useRef<number | null>(null);

  const [cardStatus, setCardStatus] = useState<{ kind: 'idle' | 'sending' | 'ok' | 'err'; msg: string }>({ kind: 'idle', msg: '' });
  const [cardHover,  setCardHover]  = useState<boolean>(false);
  const cardStatusTimerRef          = useRef<number | null>(null);
  const cardSendingRef              = useRef<boolean>(false);

  const [txPulse, setTxPulse] = useState<boolean>(false);
  const txPulseTimerRef       = useRef<number | null>(null);

  const [recent, setRecent] = useState<RecentEntry[]>([]);

  const [pin,      setPin]      = useState<string>('');
  const [maskPin,  setMaskPin]  = useState<boolean>(false);
  const pinSendingRef           = useRef<boolean>(false);

  const id = `${reader.readerId ?? reader.door ?? reader.name}`.replace(/[^A-Za-z0-9]/g, '');

  // ===== Derived =====
  const cardLoaded =
    !!pocketCard &&
    pocketCard.cardNumber !== undefined &&
    pocketCard.cardNumber !== null;

  const cardReadout = cardLoaded
    ? `FC ${pocketCard!.facilityCode ?? 0} · #${pocketCard!.cardNumber}`
    : null;

  const pinReadout =
    reader.d0Pin !== undefined && reader.d1Pin !== undefined
      ? `D0:${reader.d0Pin} D1:${reader.d1Pin}`
      : (reader.door ?? reader.name);

  const bezelWidth = 400;

  const allKeypadFormats: KeypadFormatDef[] = (() => {
    try {
      const fromJson = (emulatorFormats as any)?.keypadFormats;
      if (Array.isArray(fromJson) && fromJson.length) return fromJson as KeypadFormatDef[];
    } catch {}
    return FALLBACK_FORMATS;
  })();
  const fmtDef =
    allKeypadFormats.find(f => f.id === keypadFormat) ||
    allKeypadFormats[0] ||
    FALLBACK_FORMATS[0];

  // ===== Cleanup =====
  useEffect(() => {
    return () => {
      if (ledTimerRef.current)        window.clearTimeout(ledTimerRef.current);
      if (cardStatusTimerRef.current) window.clearTimeout(cardStatusTimerRef.current);
      if (txPulseTimerRef.current)    window.clearTimeout(txPulseTimerRef.current);
    };
  }, []);

  // ===== Helpers =====
  const flashCardStatus = (kind: 'ok' | 'err', msg: string, holdMs = 1500) => {
    setCardStatus({ kind, msg });
    if (cardStatusTimerRef.current) window.clearTimeout(cardStatusTimerRef.current);
    cardStatusTimerRef.current = window.setTimeout(() => {
      setCardStatus({ kind: 'idle', msg: '' });
      cardStatusTimerRef.current = null;
    }, holdMs);
  };

  const flashLed = (state: 'ok' | 'err', holdMs = 600) => {
    setLedState(state);
    if (ledTimerRef.current) window.clearTimeout(ledTimerRef.current);
    ledTimerRef.current = window.setTimeout(() => {
      setLedState('idle');
      ledTimerRef.current = null;
    }, holdMs);
  };

  const flashTxIndicator = (durationMs = 350) => {
    setTxPulse(true);
    if (txPulseTimerRef.current) window.clearTimeout(txPulseTimerRef.current);
    txPulseTimerRef.current = window.setTimeout(() => {
      setTxPulse(false);
      txPulseTimerRef.current = null;
    }, durationMs);
  };

  const pushRecent = (entry: RecentEntry) =>
    setRecent(prev => [entry, ...prev].slice(0, 25));

  const normalizeFormat = (f: PocketCard['format']): number => {
    if (typeof f === 'number') return f;
    if (typeof f === 'string') {
      const n = parseInt(String(f).replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return defaultFormat;
  };

  // ===== Card send (existing flow) =====
  const sendCard = async () => {
    if (!cardLoaded || cardSendingRef.current) return;
    cardSendingRef.current = true;
    setCardStatus({ kind: 'sending', msg: 'Sending…' });
    setLedState('sending');
    flashTxIndicator(800);

    try {
      const res = await fetch(`${backendUrl}/api/wiegand/transmit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          d0Pin:      reader.d0Pin,
          d1Pin:      reader.d1Pin,
          pulseWidth: reader.pulseWidth ?? 50,
          facility:   pocketCard!.facilityCode ?? 0,
          card:       pocketCard!.cardNumber,
          bits:       normalizeFormat(pocketCard!.format),
        }),
      });
      const json = await res.json();

      if (json.success) {
        flashCardStatus('ok', `✓ Sent ${cardReadout}`);
        flashLed('ok', 600);
        pushRecent({
          time: new Date().toLocaleTimeString(),
          type: 'CARD',
          description: `${cardReadout} · W${normalizeFormat(pocketCard!.format)} → ${reader.name}`,
        });
        onCardSent?.(pocketCard!);
      } else {
        flashCardStatus('err', `✗ ${json.error || 'Send failed'}`);
        flashLed('err', 800);
        pushRecent({ time: new Date().toLocaleTimeString(), type: 'ERR', description: json.error || 'Send failed' });
      }
    } catch (err: any) {
      flashCardStatus('err', `✗ ${err?.message || 'Network error'}`);
      flashLed('err', 800);
      pushRecent({ time: new Date().toLocaleTimeString(), type: 'ERR', description: err?.message || 'Network error' });
    } finally {
      cardSendingRef.current = false;
    }
  };

  const handleCardTap = () => {
    if (!cardLoaded || cardStatus.kind === 'sending') return;
    if (onCardTap) {
      onCardTap();
      flashCardStatus('ok', `✓ Tapped ${cardReadout}`, 1000);
      flashLed('ok', 500);
      flashTxIndicator(500);
    } else {
      void sendCard();
    }
  };

  // ===== Keypad transmission =====
  const getKeyValue = (key: string): number => {
    if (fmtDef.hexMap && fmtDef.hexMap[key]) return parseInt(fmtDef.hexMap[key], 16);
    if (key >= '0' && key <= '9') return parseInt(key, 10);
    if (key === '*') return 0x0A;
    if (key === '#') return 0x0B;
    return key.charCodeAt(0);
  };
  const getKeyBits = (key: string, bitLen: number): string => {
    if (fmtDef.keyMap && fmtDef.keyMap[key]) return fmtDef.keyMap[key];
    return getKeyValue(key).toString(2).padStart(bitLen, '0');
  };

  const sendPin = async () => {
    if (!pin || pinSendingRef.current) return;
    if (reader.d0Pin === undefined || reader.d1Pin === undefined) {
      flashCardStatus('err', '✗ D0/D1 pins not configured');
      flashLed('err', 800);
      pushRecent({ time: new Date().toLocaleTimeString(), type: 'ERR', description: 'D0/D1 pins not configured' });
      return;
    }

    pinSendingRef.current = true;
    setCardStatus({ kind: 'sending', msg: `PIN ${pin}…` });
    setLedState('sending');
    flashTxIndicator(800);

    const d0Pin      = reader.d0Pin;
    const d1Pin      = reader.d1Pin;
    const pulseWidth = reader.pulseWidth ?? 50;

    try {
      if (fmtDef.transmission === 'single') {
        const pinNum = parseInt(pin, 10);
        if (!Number.isFinite(pinNum)) throw new Error('Invalid PIN');

        const res = await fetch(`${backendUrl}/api/wiegand/transmit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            d0Pin, d1Pin, pulseWidth,
            facility: fmtDef.facilityCodeRequired ? facilityCode : 0,
            card: pinNum,
            bits: fmtDef.bits || 26,
          }),
        });
        const json = await res.json();
        if (!(json.success || json.ok)) throw new Error(json.error || 'Transmit failed');

        pushRecent({ time: new Date().toLocaleTimeString(), type: 'PIN', description: `${pin} · ${fmtDef.id} → ${reader.name}` });
      } else {
        const keys   = pin + '#';
        const bitLen = fmtDef.bitsPerKey ?? (fmtDef.id.startsWith('8') ? 8 : 4);

        for (let i = 0; i < keys.length; i++) {
          const k       = keys[i];
          const rawBits = getKeyBits(k, bitLen);
          const cardVal = parseInt(rawBits, 2) || 0;
          const body = {
            d0Pin,
            d1Pin,
            pulseWidth,
            facility: 0,
            card: cardVal,
            bits: bitLen,
          };

          const res = await fetch(`${backendUrl}/api/wiegand/transmit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const json = await res.json();
          if (!(json.success || json.ok)) throw new Error(`Key '${k}': ${json.error || 'failed'}`);

          if (i < keys.length - 1) await new Promise(r => setTimeout(r, 50));
        }
        pushRecent({ time: new Date().toLocaleTimeString(), type: 'PIN', description: `${pin} · ${fmtDef.id} burst → ${reader.name}` });
      }

      flashCardStatus('ok', `✓ PIN ${pin} sent`);
      flashLed('ok', 600);
      setPin('');
    } catch (err: any) {
      flashCardStatus('err', `✗ ${err?.message || 'Send failed'}`);
      flashLed('err', 800);
      pushRecent({ time: new Date().toLocaleTimeString(), type: 'ERR', description: `PIN send: ${err?.message || 'failed'}` });
    } finally {
      pinSendingRef.current = false;
    }
  };

  const handleKey = (k: string) => {
    if (k === 'Clear') { setPin(''); return; }
    if (k === 'Back')  { setPin(p => p.slice(0, -1)); return; }
    if (k === 'Send' || k === '#') { void sendPin(); return; }
    if (pin.length >= 10) return;
    setPin(p => p + k);
  };

  // ===== Render =====
  const ledHex    = LED_COLOR[ledState];
  const ledIsCalm = ledState === 'idle';
  const tapAnim   = `wg-tap-${id}`;
  const txAnim    = `wg-tx-${id}`;

  const cardZoneBorder =
    cardStatus.kind === 'ok'    ? '#22c55e'
    : cardStatus.kind === 'err' ? '#ef4444'
    : cardLoaded && cardHover   ? '#86efac'
    : cardLoaded                ? '#166534'
    : '#334155';
  const cardZoneBg = cardLoaded && cardHover ? '#0a1f0e' : '#020617';

  const KEYPAD = ['1','2','3','4','5','6','7','8','9','*','0','#'];

  return (
    <div style={{
      backgroundColor: '#3a3a3a',
      backgroundImage: BRICK_WALL_BG,
      backgroundSize: '200px 100px',
      backgroundRepeat: 'repeat',
      border: '1px solid #2a2a2a',
      borderRadius: 12,
      padding: 40,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12,
      boxShadow: 'inset 0 0 20px rgba(0,0,0,0.5)',
    }}>
      <style>{`
        @keyframes ${tapAnim} {
          0%   { box-shadow: inset 0 0 0  rgba(34, 197, 94, 0.0); transform: scale(1); }
          30%  { box-shadow: inset 0 0 16px rgba(34, 197, 94, 0.5); transform: scale(0.97); }
          100% { box-shadow: inset 0 0 0  rgba(34, 197, 94, 0.0); transform: scale(1); }
        }
        @keyframes ${txAnim} {
          0%, 100% { opacity: 0.4; }
          50%      { opacity: 1; }
        }
      `}</style>

      {/* ===== Bezel ===== */}
      <div style={{
        background: 'linear-gradient(145deg, #2a2a2e 0%, #1a1a1e 50%, #25252a 100%)',
        border: '1px solid #1a1a1e',
        borderRadius: 14,
        padding: 14,
        width: bezelWidth,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        boxShadow: '0 4px 16px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)',
      }}>
        <div style={{ fontSize: 10, color: '#cbd5e1', letterSpacing: '0.3em', textAlign: 'center' }}>
          AETHER · WIEGAND
        </div>

        {/* LED bar */}
        <div style={{
          height: 8,
          borderRadius: 4,
          background: ledHex,
          boxShadow: ledIsCalm ? `0 0 12px ${ledHex}` : `0 0 24px ${ledHex}, 0 0 4px ${ledHex}`,
          transition: 'background 0.2s ease, box-shadow 0.2s ease',
        }} />

        {/* Card target */}
        <div
          role={cardLoaded ? 'button' : undefined}
          tabIndex={cardLoaded ? 0 : undefined}
          onClick={cardLoaded ? handleCardTap : undefined}
          onMouseEnter={() => cardLoaded && setCardHover(true)}
          onMouseLeave={() => setCardHover(false)}
          onMouseDown={(e) => {
            if (cardLoaded) (e.currentTarget as HTMLDivElement).style.animation = `${tapAnim} 250ms ease`;
          }}
          onAnimationEnd={(e) => { (e.currentTarget as HTMLDivElement).style.animation = ''; }}
          style={{
            minHeight: 130,
            background: cardZoneBg,
            border: `1px dashed ${cardZoneBorder}`,
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            padding: 6,
            cursor: cardLoaded ? 'pointer' : 'default',
            transition: 'border-color 0.15s ease, background 0.15s ease',
            userSelect: 'none',
          }}
        >
          {cardStatus.kind === 'sending' ? (
            <span style={{ fontSize: 11, color: '#94a3b8' }}>{cardStatus.msg}</span>
          ) : cardStatus.kind === 'ok' ? (
            <span style={{ fontSize: 11, color: '#4ade80' }}>{cardStatus.msg}</span>
          ) : cardStatus.kind === 'err' ? (
            <span style={{ fontSize: 11, color: '#fca5a5' }}>{cardStatus.msg}</span>
          ) : (
            <>
              <span style={{ fontSize: 10, color: cardLoaded ? '#86efac' : '#475569', letterSpacing: '0.05em' }}>
                {cardLoaded ? 'Tap card' : 'Load a card →'}
              </span>
              {cardLoaded && cardReadout && (
                <span style={{ fontSize: 10, color: '#475569', fontFamily: 'ui-monospace, monospace' }}>
                  {cardReadout}
                </span>
              )}
            </>
          )}
        </div>

        {/* PIN display (editable input) */}
        <input
          type={maskPin ? 'password' : 'text'}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/[^0-9*#]/g, '').slice(0, 10))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void sendPin(); } }}
          placeholder="Enter PIN…"
          style={{
            background: 'rgba(0,0,0,0.4)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 4,
            color: '#cbd5e1',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 16,
            textAlign: 'center',
            letterSpacing: '0.3em',
            padding: '8px 4px',
            outline: 'none',
            width: '100%',
            boxSizing: 'border-box',
          }}
        />

        {/* Keypad 3x4 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {KEYPAD.map(k => (
            <button
              key={k}
              onClick={() => handleKey(k)}
              style={{
                background: 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 50%, transparent 100%)',
                color: '#f0f0f0',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 6,
                padding: '14px 0',
                fontSize: 18,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textShadow: '0 0 6px rgba(255,255,255,0.25), 0 1px 0 rgba(0,0,0,0.6)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
              }}
            >{k}</button>
          ))}
        </div>

        {/* Action row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          <button onClick={() => handleKey('Clear')} style={{
            background: 'linear-gradient(180deg, #7f1d1d 0%, #450a0a 100%)', color: '#fff',
            border: '1px solid #991b1b', borderRadius: 6, padding: '10px 0',
            fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}>Clear</button>
          <button onClick={() => handleKey('Back')} style={{
            background: 'linear-gradient(180deg, #374151 0%, #1f2937 100%)', color: '#fff',
            border: '1px solid #4b5563', borderRadius: 6, padding: '10px 0',
            fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}>Back</button>
          <button onClick={() => handleKey('Send')} style={{
            background: 'linear-gradient(180deg, #1d4ed8 0%, #1e3a8a 100%)', color: '#fff',
            border: '1px solid #2563eb', borderRadius: 6, padding: '10px 0',
            fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}>Send</button>
        </div>

        {/* Bottom info row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
          <div style={{ fontSize: 9, color: '#64748b', fontFamily: 'monospace' }}>{pinReadout}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={() => setMaskPin(m => !m)}
              title={maskPin ? 'Show PIN' : 'Mask PIN'}
              style={{
                background: 'transparent', border: '1px solid rgba(255,255,255,0.12)',
                color: '#94a3b8', fontSize: 10, padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
              }}
            >{maskPin ? '👁' : '🙈'}</button>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              opacity: txPulse ? 1 : 0.35,
              animation: txPulse ? `${txAnim} 200ms ease-in-out infinite` : 'none',
              transition: 'opacity 0.15s ease',
              color: txPulse ? '#22c55e' : '#475569',
            }}>
              <span style={{ fontSize: 9, fontWeight: 500, letterSpacing: '0.1em' }}>↗ TX</span>
            </div>
          </div>
        </div>
      </div>

      {/* ===== Status caption ===== */}
      <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', minHeight: '1.5em' }}>
        <span style={{ color: '#64748b' }}>Local:</span>{' '}
        {ledState === 'idle'      ? 'Ready'
         : ledState === 'sending' ? 'Transmitting…'
         : ledState === 'ok'      ? 'TX OK'
         : 'TX failed'}
      </div>

      {/* ===== Recent transmissions (terminal) ===== */}
      <div style={{
        width: '100%',
        background: '#000000',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 4,
        boxShadow: 'inset 0 0 14px rgba(0,255,128,0.04), 0 2px 6px rgba(0,0,0,0.5)',
        padding: '10px 12px',
        maxHeight: 330,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}>
        <div style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Recent transmissions
        </div>
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#e2e8f0', lineHeight: 1.85 }}>
          {recent.length === 0 ? (
            <div style={{ color: '#475569' }}>No transmissions yet.</div>
          ) : recent.map((r, i) => (
            <div key={i}>
              <span style={{ color: '#94a3b8' }}>{r.time}</span>{' '}
              <span style={{
                color: r.type === 'CARD' ? '#4ade80'
                     : r.type === 'PIN'  ? '#60a5fa'
                     : '#fca5a5',
              }}>{r.type}</span>{' '}
              {r.description}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
