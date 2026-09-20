import React, { useState } from 'react';
import CardEmulator from './CardEmulator';

export default function OSDPControls({ readerId }) {
  const [digits, setDigits] = useState('');

  const sendKeypad = async () => {
    if (!digits) return;
    await fetch('/api/osdp/keypad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readerId, digits })
    }).catch(()=>{});
    setDigits('');
  };

  return (
    <div style={{marginTop: 8}}>
      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <strong>OSDP Emulator Controls</strong>
        <input placeholder="Keypad digits" value={digits} onChange={e=>setDigits(e.target.value)} style={{width:160}} />
        <button onClick={sendKeypad}>Send Keypad</button>
      </div>

      <CardEmulator readerId={readerId} />
    </div>
  );
}

