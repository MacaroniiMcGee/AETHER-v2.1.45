// InteractiveReader.tsx
// Visual OSDP reader that mirrors LED/BUZ commands from the ACS controller
// and (optionally) sends keypad input + tap-to-send card credentials back.
//
// Three physical reader form factors via the `mode` prop:
//   - 'card'    : card-only reader (default; backwards compatible)
//   - 'keypad'  : PIN-only keypad reader
//   - 'both'    : combo card + keypad reader
//
// LED behaviour follows the SIA OSDP 2.2.2 two-layer model
// (permanent + temporary with auto-revert timer).
//
// Card-tap behaviour: when `pocketCard` is provided, the card target zone
// becomes a clickable trigger that sends the pre-loaded credential. The
// values are owned by a parent (typically an EmulatePage that also renders
// the card-composer panel), so the same payload can be fired by either
// the panel's Send button or by tapping the visual.

import React, { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

type ColorName = 'off' | 'red' | 'green' | 'amber' | 'blue' | 'magenta' | 'cyan' | 'white';

const COLOR_HEX: Record<ColorName, string> = {
  off:     '#1e293b',
  red:     '#ef4444',
  green:   '#22c55e',
  amber:   '#f59e0b',
  blue:    '#3b82f6',
  magenta: '#d946ef',
  cyan:    '#06b6d4',
  white:   '#f8fafc',
};

// Brick wall background (offset grey bricks) for "reader installed on wall" look
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
const BRICK_WALL_BG = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(BRICK_WALL_SVG) + '")';


interface LedLayer {
  onColor:   ColorName;
  offColor:  ColorName;
  onTimeMs:  number;
  offTimeMs: number;
}

interface LedCommandEvent {
  readerId:   string;
  address:    number;
  readerName: string;
  timestamp:  number;
  temporary:  LedLayer & { controlName: 'nop' | 'cancel' | 'set' | string; timerMs: number };
  permanent:  LedLayer & { controlName: 'nop' | 'set' | string };
}

interface BuzzerCommandEvent {
  readerId:    string;
  address:     number;
  readerName:  string;
  timestamp:   number;
  toneName:    'none' | 'off' | 'default' | string;
  onTimeMs:    number;
  offTimeMs:   number;
  repeatCount: number;
}

type ReaderMode    = 'card' | 'keypad' | 'both';
type KeypadFormat  = '8bit' | '4bit' | 'wiegand26';

/** Card credential pre-loaded into the reader's "pocket" — when set, the
 *  card target zone becomes a tappable trigger. Owned by the parent so the
 *  composer panel and the visual reader stay in sync. */
interface PocketCard {
  format?:       string;   // e.g. 'wiegand26', 'wiegand34', 'hid-h10301'
  facilityCode?: number;
  cardNumber?:   number;
}

interface InteractiveReaderProps {
  reader:           { id: string; name: string; address: number };
  socket?:          Socket;
  backendUrl?:      string;            // required for keypad and built-in card send
  mode?:            ReaderMode;        // default 'card'
  enableAudio?:     boolean;           // Web Audio beep on buzzer commands
  initialIdle?:    Partial<LedLayer>;  // override default idle (blue solid)

  // Keypad-specific:
  keypadFormat?:    KeypadFormat;      // default '8bit'
  facilityCode?:    number;            // for wiegand26 keypad format
  autoSendOnHash?:  boolean;           // press # to auto-send (default true)
  maxPinLength?:    number;            // auto-send when reached (optional)
  maskPin?:         boolean;           // show * instead of digits (default false)
  onKeypadSent?:    (pin: string) => void;

  // Card-tap-specific:
  pocketCard?:      PocketCard;        // when set, card zone becomes clickable
  onCardTap?:       () => void;        // override built-in send (parent handles POST)
  onCardSent?:      (card: PocketCard) => void;
}

interface RecentEntry {
  time:        string;
  type:        'LED' | 'BUZ' | 'KEY' | 'CARD';
  description: string;
}

const DEFAULT_IDLE: LedLayer = {
  onColor:   'blue',
  offColor:  'off',
  onTimeMs:  1000,
  offTimeMs: 0,
};

const KEYPAD_LAYOUT: string[] = ['1','2','3','4','5','6','7','8','9','*','0','#'];

export default function InteractiveReader({
  reader,
  socket,
  backendUrl,
  mode = 'card',
  enableAudio = false,
  initialIdle,
  keypadFormat = '8bit',
  facilityCode = 0,
  autoSendOnHash = true,
  maxPinLength,
  maskPin = false,
  onKeypadSent,
  pocketCard,
  onCardTap,
  onCardSent,
}: InteractiveReaderProps) {
  // ===================== LED state (two-layer, OSDP spec) =====================
  const [permanent, setPermanent] = useState<LedLayer>({ ...DEFAULT_IDLE, ...initialIdle });
  const [temporary, setTemporary] = useState<LedLayer | null>(null);
  const tempTimerRef = useRef<number | null>(null);

  // ===================== Buzzer state =====================
  const [buzzing, setBuzzing] = useState(false);
  const buzzTimerRef = useRef<number | null>(null);

  // ===== Browser audio mute toggle =====
  // Stores in localStorage so it persists across sessions.
  // Mirrors to window.__aetherAudioMuted so playBeep can read current value synchronously
  // (no React closure issues — window globals are always fresh on read).
  const [audioMuted, setAudioMuted] = useState<boolean>(() => {
    try { return localStorage.getItem('aether-audio-muted') === 'true'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('aether-audio-muted', String(audioMuted)); } catch {}
    (window as any).__aetherAudioMuted = audioMuted;
  }, [audioMuted]);

  // ===== ULTRA-MUTE: prototype-level Web Audio gate =====
  // OscillatorNode.start and AudioBufferSourceNode.start are the ONLY ways to
  // produce synthesized audio in a browser. We monkey-patch them at the prototype
  // level. After this is installed, NO web audio can play while localStorage flag
  // is set to 'true' — anywhere in the tab, from any code, even code not yet loaded.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if ((window as any).__aetherUltraMute_installed) return;

    const isMuted = () => {
      try { return localStorage.getItem('aether-audio-muted') === 'true'; }
      catch { return false; }
    };

    let blockedCount = 0;

    if (typeof OscillatorNode !== 'undefined') {
      const OrigStart = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function(this: OscillatorNode, ...args: any[]) {
        if (isMuted()) {
          blockedCount++;
          if (blockedCount <= 3) console.log('[Aether ultra-mute] OscillatorNode.start blocked (#' + blockedCount + ')');
          return undefined as any;
        }
        return OrigStart.apply(this, args as any);
      } as any;
    }

    if (typeof AudioBufferSourceNode !== 'undefined') {
      const OrigStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function(this: AudioBufferSourceNode, ...args: any[]) {
        if (isMuted()) {
          blockedCount++;
          if (blockedCount <= 3) console.log('[Aether ultra-mute] AudioBufferSourceNode.start blocked (#' + blockedCount + ')');
          return undefined as any;
        }
        return OrigStart.apply(this, args as any);
      } as any;
    }

    (window as any).__aetherUltraMute_installed = true;
    console.log('[Aether ultra-mute] ✓ Installed — Web Audio gates are now permanent');
    console.log('[Aether ultra-mute] Current localStorage flag:', localStorage.getItem('aether-audio-muted'));
  }, []);

  // ===================== Caption + log =====================
  const [lastCommand, setLastCommand] = useState<string>('Idle');
  const [recent, setRecent] = useState<RecentEntry[]>([]);

  // ===================== Keypad state =====================
  const [pin, setPin]                   = useState<string>('');
  const [keypadStatus, setKeypadStatus] = useState<{ kind: 'idle'|'sending'|'ok'|'err'; msg: string }>({ kind: 'idle', msg: '' });
  const keypadStatusTimerRef = useRef<number | null>(null);
  const sendingRef = useRef<boolean>(false);

  // ===================== Card-tap state =====================
  const [cardStatus, setCardStatus] = useState<{ kind: 'idle'|'sending'|'ok'|'err'; msg: string }>({ kind: 'idle', msg: '' });
  const [cardHover, setCardHover]   = useState<boolean>(false);
  const cardStatusTimerRef = useRef<number | null>(null);
  const cardSendingRef = useRef<boolean>(false);

  const showCard   = mode === 'card'   || mode === 'both';
  const showKeypad = mode === 'keypad' || mode === 'both';

  const cardLoaded =
    !!pocketCard &&
    pocketCard.cardNumber !== undefined &&
    pocketCard.cardNumber !== null;

  const cardReadout = cardLoaded
    ? `FC ${pocketCard!.facilityCode ?? 0} · #${pocketCard!.cardNumber}`
    : null;

  // ===================== Socket subscriptions =====================
  useEffect(() => {
    if (!socket) return;

    const onLed = (e: LedCommandEvent) => {
      if (e.address !== reader.address) return;

      if (e.permanent.controlName === 'set') {
        setPermanent({
          onColor:   e.permanent.onColor,
          offColor:  e.permanent.offColor,
          onTimeMs:  e.permanent.onTimeMs,
          offTimeMs: e.permanent.offTimeMs,
        });
      }

      if (e.temporary.controlName === 'cancel') {
        setTemporary(null);
        if (tempTimerRef.current) {
          window.clearTimeout(tempTimerRef.current);
          tempTimerRef.current = null;
        }
      } else if (e.temporary.controlName === 'set') {
        setTemporary({
          onColor:   e.temporary.onColor,
          offColor:  e.temporary.offColor,
          onTimeMs:  e.temporary.onTimeMs,
          offTimeMs: e.temporary.offTimeMs,
        });

        if (tempTimerRef.current) window.clearTimeout(tempTimerRef.current);
        if (e.temporary.timerMs > 0) {
          tempTimerRef.current = window.setTimeout(() => {
            setTemporary(null);
            tempTimerRef.current = null;
          }, e.temporary.timerMs);
        }
      }

      const layer = e.temporary.controlName === 'set' ? e.temporary : e.permanent;
      const pattern = layer.offTimeMs > 0
        ? `blink ${layer.onColor}/${layer.offColor} ${layer.onTimeMs}/${layer.offTimeMs}ms`
        : `${layer.onColor} steady`;
      const layerLabel = e.temporary.controlName === 'set'
        ? `temp ${e.temporary.timerMs}ms`
        : 'permanent';
      const desc = `LED ${pattern} (${layerLabel})`;
      setLastCommand(desc);
      setRecent(prev => [{
        time: new Date(e.timestamp).toLocaleTimeString(),
        type: 'LED',
        description: desc,
      }, ...prev].slice(0, 25));
    };

    const onBuz = (e: BuzzerCommandEvent) => {
      if (e.address !== reader.address) return;

      const totalMs = (e.onTimeMs + e.offTimeMs) * Math.max(1, e.repeatCount);
      setBuzzing(true);
      if (buzzTimerRef.current) window.clearTimeout(buzzTimerRef.current);
      buzzTimerRef.current = window.setTimeout(() => {
        setBuzzing(false);
        buzzTimerRef.current = null;
      }, Math.max(200, totalMs));

      if (enableAudio && e.toneName === 'default') {
        playBeep(e.onTimeMs || 100, e.offTimeMs || 50, e.repeatCount || 1);
      }

      const desc = `BUZ ${e.toneName} ${e.onTimeMs}/${e.offTimeMs}ms ×${e.repeatCount}`;
      setLastCommand(desc);
      setRecent(prev => [{
        time: new Date(e.timestamp).toLocaleTimeString(),
        type: 'BUZ',
        description: desc,
      }, ...prev].slice(0, 25));
    };

    socket.on('osdp_led_command', onLed);
    socket.on('osdp_buzzer_command', onBuz);

    return () => {
      socket.off('osdp_led_command', onLed);
      socket.off('osdp_buzzer_command', onBuz);
      if (tempTimerRef.current) window.clearTimeout(tempTimerRef.current);
      if (buzzTimerRef.current) window.clearTimeout(buzzTimerRef.current);
      if (keypadStatusTimerRef.current) window.clearTimeout(keypadStatusTimerRef.current);
      if (cardStatusTimerRef.current)   window.clearTimeout(cardStatusTimerRef.current);
    };
  }, [socket, reader.address, enableAudio]);

  // ===================== Keypad handlers =====================
  const flashKeypadStatus = (kind: 'ok'|'err', msg: string, holdMs = 1500) => {
    setKeypadStatus({ kind, msg });
    if (keypadStatusTimerRef.current) window.clearTimeout(keypadStatusTimerRef.current);
    keypadStatusTimerRef.current = window.setTimeout(() => {
      setKeypadStatus({ kind: 'idle', msg: '' });
      keypadStatusTimerRef.current = null;
    }, holdMs);
  };

  const sendKeypad = async (data: string) => {
    if (!data || sendingRef.current) return;
    if (!backendUrl) {
      flashKeypadStatus('err', 'No backendUrl set');
      return;
    }
    sendingRef.current = true;
    setKeypadStatus({ kind: 'sending', msg: 'Sending…' });

    try {
      const body: Record<string, any> = {
        readerId: reader.id,
        data,
        format: keypadFormat,
      };
      if (keypadFormat === 'wiegand26') body.facilityCode = facilityCode;

      const res = await fetch(`${backendUrl}/api/osdp/keypad`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();

      if (json.success) {
        flashKeypadStatus('ok', `✓ Sent ${maskPin ? '•'.repeat(data.length) : data}`);
        setPin('');
        setRecent(prev => [{
          time: new Date().toLocaleTimeString(),
          type: 'KEY',
          description: `keypad sent "${maskPin ? '•'.repeat(data.length) : data}" (${keypadFormat})`,
        }, ...prev].slice(0, 25));
        onKeypadSent?.(data);
      } else {
        flashKeypadStatus('err', `✗ ${json.error || 'Send failed'}`);
      }
    } catch (err: any) {
      flashKeypadStatus('err', `✗ ${err?.message || 'Network error'}`);
    } finally {
      sendingRef.current = false;
    }
  };

  const handleKey = (key: string) => {
    if (key === '#' && autoSendOnHash) {
      const toSend = pin;
      if (toSend) void sendKeypad(toSend);
      return;
    }

    const next = pin + key;
    setPin(next);

    if (maxPinLength && next.length >= maxPinLength) {
      void sendKeypad(next);
    }
  };

  const handleClear = () => {
    setPin('');
    setKeypadStatus({ kind: 'idle', msg: '' });
  };

  const handleBack = () => {
    setPin(prev => prev.slice(0, -1));
  };

  const handleSend = () => {
    if (pin) void sendKeypad(pin);
  };

  // ===================== Card-tap handlers =====================
  const flashCardStatus = (kind: 'ok'|'err', msg: string, holdMs = 1500) => {
    setCardStatus({ kind, msg });
    if (cardStatusTimerRef.current) window.clearTimeout(cardStatusTimerRef.current);
    cardStatusTimerRef.current = window.setTimeout(() => {
      setCardStatus({ kind: 'idle', msg: '' });
      cardStatusTimerRef.current = null;
    }, holdMs);
  };

  const sendCard = async () => {
    if (!cardLoaded || cardSendingRef.current) return;
    if (!backendUrl) {
      flashCardStatus('err', 'No backendUrl set');
      return;
    }
    cardSendingRef.current = true;
    setCardStatus({ kind: 'sending', msg: 'Sending…' });

    try {
      const res = await fetch(`${backendUrl}/api/osdp/card-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          readerId: reader.id,
          facility: pocketCard!.facilityCode ?? 0,
          card:     pocketCard!.cardNumber,
          format:   pocketCard!.format || 'wiegand26',
        }),
      });
      const json = await res.json();

      if (json.success) {
        flashCardStatus('ok', `✓ Sent ${cardReadout}`);
        setRecent(prev => [{
          time: new Date().toLocaleTimeString(),
          type: 'CARD',
          description: `card sent ${cardReadout} (${pocketCard!.format || 'wiegand26'})`,
        }, ...prev].slice(0, 25));
        onCardSent?.(pocketCard!);
      } else {
        flashCardStatus('err', `✗ ${json.error || 'Send failed'}`);
      }
    } catch (err: any) {
      flashCardStatus('err', `✗ ${err?.message || 'Network error'}`);
    } finally {
      cardSendingRef.current = false;
    }
  };

  const handleCardTap = () => {
    if (!cardLoaded || cardStatus.kind === 'sending') return;
    if (onCardTap) {
      onCardTap();
      // Show a quick "Tapped" confirmation since the parent handles the actual POST
      flashCardStatus('ok', `✓ Tapped ${cardReadout}`, 1000);
    } else {
      void sendCard();
    }
  };

  // ===================== Derived LED render values =====================
  const effective   = temporary ?? permanent;
  const isBlinking  = effective.onTimeMs > 0 && effective.offTimeMs > 0;
  const onHex       = COLOR_HEX[effective.onColor]  ?? COLOR_HEX.off;
  const offHex      = COLOR_HEX[effective.offColor] ?? COLOR_HEX.off;
  const isOn        = effective.onTimeMs > 0;
  const cycleMs     = effective.onTimeMs + effective.offTimeMs;
  const onPct       = cycleMs > 0 ? (effective.onTimeMs / cycleMs) * 100 : 100;

  const blinkAnim = `led-blink-0x${reader.address.toString(16)}`;
  const buzzAnim  = `buz-pulse-0x${reader.address.toString(16)}`;
  const pressAnim = `key-press-0x${reader.address.toString(16)}`;
  const tapAnim   = `card-tap-0x${reader.address.toString(16)}`;

  const bezelWidth = mode === 'both' ? 390 : 385;

  // ===================== Recent activity export =====================
  const [copyFlash, setCopyFlash] = useState(false);
  const exportRecentAsText = () =>
    recent.map(r => `${r.time}  ${r.type.padEnd(4)}  ${r.description}`).join('\n');
  const exportRecentAsCSV = () => {
    const esc = (v: string) => '"' + String(v).replace(/"/g, '""') + '"';
    const rows = recent.map(r => [esc(r.time), esc(r.type), esc(r.description)].join(','));
    return ['time,type,description', ...rows].join('\n');
  };
  const copyRecent = async () => {
    if (recent.length === 0) return;
    const text = exportRecentAsText();
    let ok = false;
    // Modern clipboard API — only works in secure contexts (HTTPS/localhost)
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); ok = true; }
      catch (e) { console.warn('[copy] navigator.clipboard failed:', e); }
    }
    // Fallback for plain-HTTP LAN access — works without secure context
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) { console.warn('[copy] execCommand fallback failed:', e); }
    }
    if (ok) {
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1200);
    } else {
      console.error('[copy] All methods failed. Text dumped below:');
      console.log(text);
      alert('Copy not available in this browser context. Activity logged to DevTools console.');
    }
  };
  const downloadRecent = () => {
    if (recent.length === 0) return;
    const blob = new Blob([exportRecentAsCSV()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aether-recent-${reader.id}-${Date.now()}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ===================== Card zone style helpers =====================
  const cardZoneBorder =
    cardStatus.kind === 'ok'      ? '#22c55e'
    : cardStatus.kind === 'err'   ? '#ef4444'
    : cardLoaded && cardHover     ? '#67e8f9'
    : cardLoaded                  ? '#1e7488'
    : '#334155';

  const cardZoneBg =
    cardLoaded && cardHover ? '#051820' : '#020617';

  // ===================== Render =====================
  return (
    <div style={{
      backgroundColor: '#3a3a3a',
      backgroundImage: BRICK_WALL_BG,
      backgroundSize: '200px 100px',
      backgroundRepeat: 'repeat',
      border: '1px solid #2a2a2a',
      borderRadius: 12,
      padding: 30,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12,
      boxShadow: 'inset 0 0 20px rgba(0,0,0,0.5)',
    }}>
      <style>{`
        @keyframes ${blinkAnim} {
          0%, ${Math.max(0, onPct - 0.01)}% {
            background-color: ${onHex};
            box-shadow: 0 0 24px ${onHex}, 0 0 4px ${onHex};
          }
          ${onPct}%, 100% {
            background-color: ${offHex};
            box-shadow: none;
          }
        }
        @keyframes ${buzzAnim} {
          0%, 100% { transform: scale(1);   opacity: 1;   }
          50%      { transform: scale(1.3); opacity: 0.5; }
        }
        @keyframes ${pressAnim} {
          0%   { transform: scale(1);    background: #1e293b; }
          50%  { transform: scale(0.92); background: #475569; }
          100% { transform: scale(1);    background: #1e293b; }
        }
        @keyframes ${tapAnim} {
          0%   { box-shadow: inset 0 0 0  rgba(34, 211, 238, 0.0); transform: scale(1); }
          30%  { box-shadow: inset 0 0 16px rgba(34, 211, 238, 0.5); transform: scale(0.97); }
          100% { box-shadow: inset 0 0 0  rgba(34, 211, 238, 0.0); transform: scale(1); }
        }
      `}</style>

      {/* ====== Reader bezel ====== */}
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
        <div style={{
          fontSize: 10, color: '#64748b',
          letterSpacing: '0.3em', textAlign: 'center',
        }}>
          AETHER · OSDP
        </div>

        {/* LED bar */}
        <div style={{
          height: 8,
          borderRadius: 4,
          background: isBlinking ? offHex : (isOn ? onHex : offHex),
          animation: isBlinking ? `${blinkAnim} ${cycleMs}ms step-end infinite` : 'none',
          boxShadow: !isBlinking && isOn && effective.onColor !== 'off'
            ? `0 0 24px ${onHex}, 0 0 4px ${onHex}`
            : 'none',
          transition: 'background 0.15s ease, box-shadow 0.15s ease',
        }} />

        {/* Card target — clickable when pocketCard is loaded */}
        {showCard && (
          <div
            role={cardLoaded ? 'button' : undefined}
            tabIndex={cardLoaded ? 0 : undefined}
            onClick={cardLoaded ? handleCardTap : undefined}
            onMouseEnter={() => cardLoaded && setCardHover(true)}
            onMouseLeave={() => setCardHover(false)}
            onKeyDown={(e) => {
              if (cardLoaded && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                handleCardTap();
              }
            }}
            onAnimationEnd={(e) => {
              (e.currentTarget as HTMLDivElement).style.animation = '';
            }}
            style={{
              height: mode === 'both' ? 50 : undefined,
              aspectRatio: mode === 'both' ? undefined : '1',
              background: cardZoneBg,
              border: `1px dashed ${cardZoneBorder}`,
              borderRadius: 8,
              display: 'flex',
              flexDirection: mode === 'both' ? 'row' : 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: mode === 'both' ? 8 : 4,
              cursor: cardLoaded ? 'pointer' : 'default',
              transition: 'border-color 0.15s ease, background 0.15s ease',
              userSelect: 'none',
              padding: mode === 'both' ? '0 10px' : 0,
            }}
            onMouseDown={(e) => {
              if (cardLoaded) {
                (e.currentTarget as HTMLDivElement).style.animation = `${tapAnim} 250ms ease`;
              }
            }}
          >
            {cardStatus.kind === 'sending' ? (
              <span style={{ fontSize: 11, color: '#94a3b8' }}>Sending…</span>
            ) : cardStatus.kind === 'ok' ? (
              <span style={{ fontSize: 11, color: '#4ade80' }}>{cardStatus.msg}</span>
            ) : cardStatus.kind === 'err' ? (
              <span style={{ fontSize: 11, color: '#fca5a5' }}>{cardStatus.msg}</span>
            ) : (
              <>
                <i className="ti ti-credit-card"
                   style={{
                     fontSize: mode === 'both' ? 22 : 40,
                     color: cardLoaded ? '#0e7490' : '#334155',
                   }}
                   aria-hidden />
                <div style={{
                  display: 'flex',
                  flexDirection: mode === 'both' ? 'row' : 'column',
                  alignItems: 'center',
                  gap: mode === 'both' ? 8 : 3,
                }}>
                  <span style={{
                    fontSize: 10,
                    color: cardLoaded ? '#67e8f9' : '#475569',
                    letterSpacing: '0.05em',
                  }}>
                    {cardLoaded ? 'Tap card' : 'Load a card →'}
                  </span>
                  {cardLoaded && cardReadout && (
                    <span style={{
                      fontSize: 10,
                      color: '#475569',
                      fontFamily: 'ui-monospace, monospace',
                    }}>
                      {mode === 'both' ? '·' : ''} {cardReadout}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Keypad */}
        {showKeypad && (
          <>
            {/* PIN display */}
            <div style={{
              background: '#020617',
              border: '1px solid #1e293b',
              borderRadius: 6,
              padding: '8px 10px',
              minHeight: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'ui-monospace, monospace',
              fontSize: 14,
              letterSpacing: '0.25em',
              color: pin ? '#22d3ee' : '#334155',
            }}>
              {pin
                ? (maskPin ? '•'.repeat(pin.length) : pin)
                : 'Enter PIN…'}
            </div>

            {/* 3×4 keypad grid */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 4,
            }}>
              {KEYPAD_LAYOUT.map(k => (
                <button
                  key={k}
                  onClick={() => handleKey(k)}
                  onMouseDown={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.animation = `${pressAnim} 120ms ease`;
                  }}
                  onAnimationEnd={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.animation = '';
                  }}
                  style={{
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 50%, transparent 100%)',
                    color: '#f0f0f0',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 6,
                    padding: '8px 0',
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textShadow: '0 0 6px rgba(255,255,255,0.25), 0 1px 0 rgba(0,0,0,0.6)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                  }}
                >
                  {k}
                </button>
              ))}
            </div>

            {/* Clear / Back / Send row */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
              <button onClick={handleClear} style={btnStyle('#7f1d1d', '#fca5a5')}>Clear</button>
              <button onClick={handleBack}  style={btnStyle('#334155', '#cbd5e1')}>Back</button>
              <button
                onClick={handleSend}
                disabled={!pin || keypadStatus.kind === 'sending'}
                style={{
                  ...btnStyle('#0e7490', '#67e8f9'),
                  opacity: (!pin || keypadStatus.kind === 'sending') ? 0.4 : 1,
                  cursor: (!pin || keypadStatus.kind === 'sending') ? 'not-allowed' : 'pointer',
                }}
              >
                Send
              </button>
            </div>

            {/* Keypad transient status */}
            <div style={{
              fontSize: 10,
              minHeight: '1.2em',
              textAlign: 'center',
              color: keypadStatus.kind === 'ok'
                ? '#4ade80'
                : keypadStatus.kind === 'err'
                  ? '#fca5a5'
                  : keypadStatus.kind === 'sending'
                    ? '#94a3b8'
                    : '#475569',
            }}>
              {keypadStatus.msg || ' '}
            </div>
          </>
        )}

        {/* Address + speaker */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div style={{ fontSize: 9, color: '#475569', fontFamily: 'monospace' }}>
            0x{reader.address.toString(16).padStart(2, '0').toUpperCase()}
          </div>
          <button
            onClick={() => setAudioMuted(!audioMuted)}
            title={audioMuted ? 'Audio MUTED — click to unmute' : 'Audio ON — click to mute'}
            aria-label={audioMuted ? 'Unmute audio' : 'Mute audio'}
            style={{
              background: audioMuted ? '#5a1a1a' : 'rgba(51, 65, 85, 0.6)',
              border: audioMuted ? '1px solid #ef4444' : '1px solid rgba(100, 116, 139, 0.6)',
              borderRadius: 4,
              cursor: 'pointer',
              padding: '3px 8px',
              color: audioMuted ? '#fca5a5' : (buzzing ? '#4ade80' : '#67e8f9'),
              animation: (buzzing && !audioMuted) ? `${buzzAnim} 200ms ease-in-out infinite` : 'none',
              fontSize: 11,
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontFamily: 'inherit',
            }}
          >
            <span style={{fontSize: 12}}>{audioMuted ? '🔇' : '🔊'}</span>
            <span style={{fontSize: 9, fontWeight: 'bold', letterSpacing: '0.5px'}}>{audioMuted ? 'MUTE' : 'AUDIO'}</span>
          </button>
        </div>
      </div>

      {/* ====== ACS caption ====== */}
      <div style={{
        fontSize: 11,
        color: '#94a3b8',
        textAlign: 'center',
        minHeight: '1.5em',
      }}>
        <span style={{ color: '#64748b' }}>ACS:</span> {lastCommand}
      </div>

      {/* ====== Recent activity ====== */}
      {recent.length > 0 && (
        <div style={{ width: '100%', background: '#000000', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, boxShadow: 'inset 0 0 14px rgba(0,255,128,0.04), 0 2px 6px rgba(0,0,0,0.5)', padding: '10px 12px', maxHeight: 280, overflowY: 'auto' /* TERMINAL_BG_v4 */ }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}>
            <div style={{
              fontSize: 10, color: '#64748b',
              textTransform: 'uppercase', letterSpacing: '0.05em',
            }}>
              Recent activity{copyFlash && <span style={{color:'#4ade80', marginLeft:6}}>· copied</span>}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={copyRecent} title="Copy to clipboard"
                      disabled={recent.length === 0}
                      style={{...miniBtn, opacity: recent.length === 0 ? 0.4 : 1,
                              cursor: recent.length === 0 ? 'not-allowed' : 'pointer'}}>📋</button>
              <button onClick={downloadRecent} title="Download CSV"
                      disabled={recent.length === 0}
                      style={{...miniBtn, opacity: recent.length === 0 ? 0.4 : 1,
                              cursor: recent.length === 0 ? 'not-allowed' : 'pointer'}}>⬇</button>
            </div>
          </div>
          <div style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
            color: '#e2e8f0',
            lineHeight: 1.85,
          }}>
            {recent.map((r, i) => (
              <div key={i}>
                <span style={{ color: '#94a3b8' }}>{r.time}</span>{' '}
                <span style={{
                  color: r.type === 'LED'  ? '#60a5fa'
                       : r.type === 'BUZ'  ? '#fbbf24'
                       : r.type === 'CARD' ? '#4ade80'
                       : '#22d3ee',
                }}>{r.type}</span>{' '}
                {r.description}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ===================== Helpers =====================
const miniBtn: React.CSSProperties = {
  background: '#0f172a',
  color: '#94a3b8',
  border: '1px solid #1e293b',
  borderRadius: 4,
  padding: '2px 6px',
  fontSize: 11,
  lineHeight: 1,
  fontFamily: 'inherit',
};

function btnStyle(bg: string, fg: string): React.CSSProperties {
  return {
    background: bg,
    color: fg,
    border: 'none',
    borderRadius: 6,
    padding: '7px 0',
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

function playBeep(onMs: number, offMs: number, repeats: number) {
    // === AUDIO MUTE GATE === window flag is updated synchronously in useEffect
    if (typeof window !== 'undefined' && (window as any).__aetherAudioMuted) return;
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    let t = ctx.currentTime;
    for (let i = 0; i < Math.max(1, repeats); i++) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 2400;
      gain.gain.value = 0.10;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + onMs / 1000);
      t += (onMs + offMs) / 1000;
    }
  } catch {
    /* audio unavailable — silently skip */
  }
}
