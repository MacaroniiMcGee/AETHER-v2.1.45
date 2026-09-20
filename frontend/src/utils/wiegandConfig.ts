export type DoorCfg = { door: number; name: string; d0: number; d1: number };
export type WiegandConfig = { chip: string; doors: DoorCfg[]; reserved: number[] };

let cached: WiegandConfig | null = null;

export async function fetchWiegandConfig(): Promise<WiegandConfig> {
  if (cached) return cached;
  const r = await fetch("/api/wiegand/config");
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || "Failed to load Wiegand config");
  cached = { chip: j.chip, doors: j.doors, reserved: j.reserved };
  return cached;
}
