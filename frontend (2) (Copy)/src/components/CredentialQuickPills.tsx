import React, { useState, useEffect, useRef } from 'react';

export type Credential = {
  formatId: string;
  bits: number;
  facility: number;
  cardNumber: number;
  issueLevel: number;
};

export type SavedCard = Credential & { name: string };

type Props = {
  current: Credential;
  onLoad: (cred: Partial<Credential>) => void;
  onLog?: (msg: string) => void;
  hasIssueLevel?: boolean;
};

const STORAGE_KEY = 'aether-saved-cards-v1';

export default function CredentialQuickPills({ current, onLoad, onLog }: Props) {
  const [savedCards, setSavedCards] = useState<(SavedCard | null)[]>(() => {
    // Lazy initializer — runs once on first render, before any effects.
    // Avoids the load-effect/save-effect race that wiped slots on mount.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 4) return parsed;
      }
    } catch {}
    return [null, null, null, null];
  });
  const [previousCred, setPreviousCred] = useState<Credential | null>(null);
  const [editing, setEditing] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedCards)); } catch {}
  }, [savedCards]);

  const snapshot = () => setPreviousCred({ ...current });

  const loadSlot = (i: number) => {
    const c = savedCards[i];
    if (!c) { onLog?.('○ Slot ' + (i + 1) + ' empty — click 💾 Save to fill'); return; }
    snapshot();
    onLoad({ formatId: c.formatId, bits: c.bits, facility: c.facility, cardNumber: c.cardNumber, issueLevel: c.issueLevel ?? 0 });
    onLog?.('↻ Loaded "' + c.name + '" → FC ' + c.facility + ' #' + c.cardNumber);
  };

  const loadPrev = () => {
    if (!previousCred) { onLog?.('○ No previous credential'); return; }
    const swap = { ...current };
    onLoad(previousCred);
    setPreviousCred(swap);
    onLog?.('↶ Restored previous credential');
  };

  const resetCred = () => {
    snapshot();
    onLoad({ facility: 0, cardNumber: 0, issueLevel: 0 });
    onLog?.('Credential reset');
  };

  const saveToSlot = (i: number, name?: string) => {
    const finalName = name || savedCards[i]?.name || ('Card ' + (i + 1));
    setSavedCards(prev => { const n = [...prev]; n[i] = { name: finalName, ...current }; return n; });
    onLog?.('💾 Saved slot ' + (i + 1) + ': FC ' + current.facility + ' #' + current.cardNumber);
  };

  const saveCurrent = () => {
    const empty = savedCards.findIndex(c => c === null);
    if (empty >= 0) saveToSlot(empty);
    else { setEditing(true); onLog?.('○ All slots full — pick one to overwrite'); }
  };

  const deleteSlot = (i: number) => {
    setSavedCards(prev => { const n = [...prev]; n[i] = null; return n; });
    onLog?.('🗑️ Cleared slot ' + (i + 1));
  };

  const renameSlot = (i: number, name: string) => {
    setSavedCards(prev => { const n = [...prev]; if (n[i]) n[i] = { ...n[i]!, name }; return n; });
  };

  // ── Export / Import ────────────────────────────────────────────
  const exportSlots = () => {
    const data = {
      version: 1,
      exported: new Date().toISOString(),
      slots: savedCards,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().split('.')[0].replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aether-slots-' + stamp + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onLog?.('📤 Exported slot config (' + savedCards.filter(c => c).length + ' slots)');
  };

  const importSlots = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      let slots: (SavedCard | null)[];

      if (Array.isArray(parsed) && parsed.length === 4) {
        slots = parsed;
      } else if (parsed && Array.isArray(parsed.slots) && parsed.slots.length === 4) {
        slots = parsed.slots;
      } else {
        throw new Error('Expected array of 4 slots or {slots: [...]}');
      }

      // Validate
      for (const slot of slots) {
        if (slot !== null) {
          if (typeof slot !== 'object' ||
              typeof slot.name !== 'string' ||
              typeof slot.formatId !== 'string' ||
              typeof slot.facility !== 'number' ||
              typeof slot.cardNumber !== 'number') {
            throw new Error('Invalid slot structure');
          }
        }
      }

      const filledCount = slots.filter(s => s !== null).length;
      const currentCount = savedCards.filter(c => c !== null).length;
      const ok = window.confirm(
        'Replace current ' + currentCount + ' saved slots with imported ' + filledCount + ' slots?\n\n' +
        'This cannot be undone (but you can re-export current slots first).'
      );

      if (ok) {
        setSavedCards(slots);
        onLog?.('📥 Imported ' + filledCount + ' slots from ' + file.name);
      }
    } catch (err: any) {
      onLog?.('✗ Import failed: ' + err.message);
      window.alert('Import failed: ' + err.message);
    } finally {
      if (e.target) e.target.value = '';
    }
  };

  const pill: React.CSSProperties = {
    padding: '6px 4px', border: '1px solid rgba(100, 116, 139, 0.4)', borderRadius: 4,
    backgroundColor: 'rgba(51, 65, 85, 0.4)', color: '#fff', cursor: 'pointer', fontSize: 11,
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    minHeight: 38, fontFamily: 'inherit',
  };

  const smallBtn: React.CSSProperties = {
    background: 'rgba(51, 65, 85, 0.4)', border: '1px solid rgba(100, 116, 139, 0.4)', color: '#eee',
    cursor: 'pointer', padding: '3px 8px', fontSize: 9, borderRadius: 3,
  };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
        <span>Quick Credentials</span>
        {previousCred && <span style={{ color: '#67e8f9', fontSize: 10 }}>↶ Prev available</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, marginBottom: 4 }}>
        {[0, 1, 2, 3].map(i => {
          const c = savedCards[i];
          return (
            <button
              key={i}
              onClick={() => loadSlot(i)}
              onContextMenu={(e) => { e.preventDefault(); if (c) deleteSlot(i); }}
              title={c ? c.name + '\n' + c.formatId + ' FC=' + c.facility + ' #' + c.cardNumber + '\n(right-click to clear)' : 'Slot ' + (i+1) + ' — empty'}
              style={{ ...pill, opacity: c ? 1 : 0.55, background: c ? 'rgba(51, 65, 85, 0.6)' : 'rgba(51, 65, 85, 0.4)', borderColor: c ? '#22d3ee' : 'rgba(100, 116, 139, 0.4)' }}
            >
              <div style={{ fontSize: 10, color: c ? '#67e8f9' : '#666', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                {c ? c.name : 'Slot ' + (i+1)}
              </div>
              {c && <div style={{ fontSize: 9, color: '#888', fontFamily: 'monospace', marginTop: 1 }}>FC{c.facility} #{c.cardNumber}</div>}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
        <button onClick={loadPrev} disabled={!previousCred} title="Restore previous credential" style={{ ...pill, opacity: previousCred ? 1 : 0.4, cursor: previousCred ? 'pointer' : 'not-allowed' }}>↶ Prev</button>
        <button onClick={resetCred} title="Reset facility/card/issue to zero" style={pill}> Reset</button>
        <button onClick={saveCurrent} title="Save current to next empty slot" style={{ ...pill, opacity: previousCred}}>💾 Save</button>
        <button onClick={() => setEditing(!editing)} title="Manage saved slots, backup/restore" style={{ ...pill, background: editing ? 'rgba(14, 116, 144, 0.3)' : 'rgba(51, 65, 85, 0.4)', borderColor: editing ? '#22d3ee' : 'rgba(100, 116, 139, 0.4)' }}>✏️ Edit</button>
      </div>

      {editing && (
        <div style={{ marginTop: 6, padding: 8, background: 'rgba(0, 0, 0, 0.4)', border: '1px solid rgba(51, 65, 85, 0.4)', borderRadius: 4 }}>
          <div style={{ fontSize: 10, color: '#888', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
            <span>Manage saved slots</span>
            <button onClick={() => setEditing(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 10 }}>close ×</button>
          </div>
          {savedCards.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4, fontSize: 10 }}>
              <span style={{ color: '#888', minWidth: 18 }}>{i + 1}.</span>
              {c ? (
                <>
                  <input
                    type="text"
                    value={c.name}
                    onChange={(e) => renameSlot(i, e.target.value)}
                    style={{ flex: 1, background: 'rgba(0, 0, 0, 0.25)', border: '1px solid rgba(100, 116, 139, 0.4)', borderRadius: 3, color: '#eee', fontSize: 10, padding: '3px 6px', fontFamily: 'inherit' }}
                  />
                  <span style={{ color: '#666', fontFamily: 'monospace', fontSize: 9, minWidth: 100, whiteSpace: 'nowrap' }}>
                    {c.formatId} FC{c.facility} #{c.cardNumber}
                  </span>
                  <button onClick={() => saveToSlot(i, c.name)} title="Overwrite with current credential" style={{ background: '#1a4a1a', border: '1px solid #22c55e', color: '#4ade80', cursor: 'pointer', padding: '3px 6px', fontSize: 9, borderRadius: 3 }}>↑ Overwrite</button>
                  <button onClick={() => deleteSlot(i)} title="Delete slot" style={{ background: '#5a1a1a', border: '1px solid #ef4444', color: '#fca5a5', cursor: 'pointer', padding: '3px 8px', fontSize: 9, borderRadius: 3 }}>×</button>
                </>
              ) : (
                <>
                  <span style={{ color: '#666', flex: 1, fontStyle: 'italic' }}>(empty)</span>
                  <button onClick={() => saveToSlot(i)} style={smallBtn}>Save current here</button>
                </>
              )}
            </div>
          ))}

          {/* ── Backup / Restore row ──────────────────────────── */}
          <div style={{
            borderTop: '1px solid rgba(51, 65, 85, 0.4)',
            paddingTop: 8,
            marginTop: 8,
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            fontSize: 10,
            flexWrap: 'wrap',
          }}>
            <span style={{ color: '#888', fontSize: 9, fontWeight: 600 }}>Backup:</span>
            <button
              onClick={exportSlots}
              title="Download all 4 slots as JSON file (transfer between machines)"
              style={{ background: 'rgba(51, 65, 85, 0.6)', border: '1px solid #22d3ee', color: '#67e8f9', cursor: 'pointer', padding: '3px 8px', fontSize: 9, borderRadius: 3 }}
            >📤 Export</button>
            <button
              onClick={() => importInputRef.current?.click()}
              title="Load slots from previously-exported JSON file"
              style={{ background: 'rgba(51, 65, 85, 0.4)', border: '1px solid rgba(100, 116, 139, 0.4)', color: '#eee', cursor: 'pointer', padding: '3px 8px', fontSize: 9, borderRadius: 3 }}
            >📥 Import</button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              onChange={importSlots}
              style={{ display: 'none' }}
            />
            <span style={{ marginLeft: 'auto', color: '#475569', fontSize: 9, fontFamily: 'monospace' }}>
              {savedCards.filter(c => c).length}/4 filled · saved to device automatically
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
