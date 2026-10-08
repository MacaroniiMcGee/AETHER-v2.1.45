export async function listReaders() {
  const r = await fetch('/api/osdp/readers');
  if (!r.ok) throw new Error('Failed to list readers');
  return r.json();
}

