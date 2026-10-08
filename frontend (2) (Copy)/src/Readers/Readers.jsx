import React, { useEffect, useState } from 'react';
import { listReaders } from '../api/osdp';
import OSDPControls from '../components/OSDPControls';

export default function Readers() {
  const [readers, setReaders] = useState([]);

  useEffect(() => {
    listReaders().then(setReaders).catch(()=>setReaders([]));
  }, []);

  return (
    <div style={{padding:16}}>
      <h2>OSDP Readers</h2>
      {readers.map(r => (
        <div key={r.id} style={{border:'1px solid #ccc', borderRadius: 12, padding: 12, marginBottom: 12}}>
          <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
            <div>
              <strong>{r.name}</strong> · Addr {r.address} · {r.enabled ? 'Enabled' : 'Disabled'} · Status: {r.status}
            </div>
          </div>
          <OSDPControls readerId={r.id} />
        </div>
      ))}
      {!readers.length && <div style={{opacity:0.7}}>No readers</div>}
    </div>
  );
}

