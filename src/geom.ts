// Polyline helpers in a local metric frame: x = east, z = south, h = height above ground.

export type V2 = { x: number; z: number; h?: number };

// ---------------------------------------------------------------------------
// Polyline helpers (x/z plane, metres)

export function segLen(a: V2, b: V2): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

export function polyLength(p: V2[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += segLen(p[i - 1], p[i]);
  return s;
}

/** Right-hand normal at each vertex, miter-scaled (clamped) so offsets stay parallel. */
export function vertexNormals(p: V2[]): V2[] {
  const n = p.length;
  const segN: V2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = p[i + 1].x - p[i].x;
    const dz = p[i + 1].z - p[i].z;
    const l = Math.hypot(dx, dz) || 1;
    segN.push({ x: -dz / l, z: dx / l });
  }
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = segN[Math.max(0, i - 1)];
    const b = segN[Math.min(n - 2, i)];
    let x = a.x + b.x;
    let z = a.z + b.z;
    const l = Math.hypot(x, z);
    if (l < 1e-6) {
      out.push(b);
      continue;
    }
    x /= l;
    z /= l;
    const cos = x * b.x + z * b.z;
    const scale = Math.min(1 / Math.max(cos, 1e-3), 3);
    out.push({ x: x * scale, z: z * scale });
  }
  return out;
}

/** Sub-polyline between arc-lengths s0..s1. */
export function slice(p: V2[], s0: number, s1: number): V2[] {
  const out: V2[] = [];
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const l = segLen(a, b);
    const e = acc + l;
    if (e >= s0 && acc <= s1 && l > 0) {
      const t0 = Math.max(0, (s0 - acc) / l);
      const t1 = Math.min(1, (s1 - acc) / l);
      const ha = a.h ?? 0, hb = b.h ?? 0;
      const pa = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0, h: ha + (hb - ha) * t0 };
      const pb = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1, h: ha + (hb - ha) * t1 };
      if (!out.length) out.push(pa);
      // A cut that lands exactly on a vertex would otherwise add a zero-length piece,
      // which has no direction and skews anything offset from it.
      const last = out[out.length - 1];
      if (Math.hypot(pb.x - last.x, pb.z - last.z) > 1e-6) out.push(pb);
    }
    acc = e;
    if (acc > s1) break;
  }
  return out;
}

export function pointAt(p: V2[], s: number): { p: V2; dir: V2 } {
  let acc = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const b = p[i];
    const l = segLen(a, b);
    if (acc + l >= s || i === p.length - 1) {
      const t = l > 0 ? Math.min(1, Math.max(0, (s - acc) / l)) : 0;
      return {
        p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, h: (a.h ?? 0) + ((b.h ?? 0) - (a.h ?? 0)) * t },
        dir: { x: (b.x - a.x) / (l || 1), z: (b.z - a.z) / (l || 1) },
      };
    }
    acc += l;
  }
  return { p: p[0], dir: { x: 0, z: -1 } };
}

/** Push a flat ribbon between lateral offsets a..b (triangles, xyz). */
export function strip(out: number[], p: V2[], a: number, b: number, y: number): number {
  if (p.length < 2) return 0;
  const n = vertexNormals(p);
  let tris = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const a0x = p[i].x + n[i].x * a, a0z = p[i].z + n[i].z * a;
    const b0x = p[i].x + n[i].x * b, b0z = p[i].z + n[i].z * b;
    const a1x = p[i + 1].x + n[i + 1].x * a, a1z = p[i + 1].z + n[i + 1].z * a;
    const b1x = p[i + 1].x + n[i + 1].x * b, b1z = p[i + 1].z + n[i + 1].z * b;
    const y0 = (p[i].h ?? 0) + y, y1 = (p[i + 1].h ?? 0) + y;
    out.push(a0x, y0, a0z, a1x, y1, a1z, b0x, y0, b0z);
    out.push(b0x, y0, b0z, a1x, y1, a1z, b1x, y1, b1z);
    tris += 2;
  }
  return tris;
}

export function line(out: number[], p: V2[], offset: number, width: number, y: number, dash?: [number, number], trim = [0, 0]) {
  const L = polyLength(p);
  const s0 = trim[0];
  const s1 = L - trim[1];
  if (s1 - s0 < 0.5) return;
  if (!dash) {
    strip(out, slice(p, s0, s1), offset - width / 2, offset + width / 2, y);
    return;
  }
  const [on, off] = dash;
  for (let s = s0; s < s1; s += on + off) {
    const sub = slice(p, s, Math.min(s + on, s1));
    strip(out, sub, offset - width / 2, offset + width / 2, y);
  }
}


/** A polyline shifted sideways by `off` metres (+ is right of its direction). */
export function offsetLine(p: V2[], off: number): V2[] {
  const n = vertexNormals(p);
  return p.map((q, i) => ({ x: q.x + n[i].x * off, z: q.z + n[i].z * off, h: q.h }));
}
