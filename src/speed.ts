// Speed limits: parsing `maxspeed` values and the colours of the speed-limit view.

export interface Speed {
  kmh: number;
  mph: boolean;
}

/** Parse a `maxspeed` value ("50", "30 mph", "walk", "none"); undefined when not a speed. */
export function parseSpeed(v: string | undefined): Speed | undefined {
  if (!v) return undefined;
  const t = v.trim().toLowerCase();
  if (t === 'walk') return { kmh: 7, mph: false };
  if (t === 'none') return { kmh: 999, mph: false };
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/.exec(t);
  if (!m) return undefined;
  const mph = m[2] === 'mph';
  return { kmh: parseFloat(m[1]) * (mph ? 1.609344 : 1), mph };
}

/** Upper bound (km/h) and colour of each band, slow → fast. */
export const SPEED_BANDS: [number, number][] = [
  [20, 0x4fc3f7], [30, 0x4db6ac], [40, 0x81c784], [50, 0xc0ca33], [60, 0xfdd835],
  [70, 0xffb300], [80, 0xfb8c00], [100, 0xf4511e], [120, 0xad5389], [Infinity, 0x7e57c2],
];
export const SPEED_MISSING = 0xd32f2f;

export function speedColour(v: string | undefined): number {
  const s = parseSpeed(v);
  if (!s) return SPEED_MISSING;
  // Small tolerance so 30 mph (48.3 km/h) lands in the 50 band, not above it.
  return SPEED_BANDS.find(([max]) => s.kmh <= max + 1.5)![1];
}

export const KMH_CHOICES = [20, 30, 40, 50, 60, 70, 80, 100, 120, 130];
export const MPH_CHOICES = [20, 30, 40, 50, 60, 70];
