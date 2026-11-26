// Canvas-drawn textures: road turn arrows and overhead destination sign panels.

import * as THREE from 'three';

const arrowCache = new Map<string, THREE.CanvasTexture>();

/** Angle (degrees, 0 = straight ahead, + = right) of each turn branch. */
const TURN_ANGLE: Record<string, number> = {
  through: 0,
  slight_left: -35,
  left: -80,
  sharp_left: -130,
  slight_right: 35,
  right: 80,
  sharp_right: 130,
};

/**
 * Draw a painted road arrow for a `turn:lanes` value like "through;right".
 * Canvas is 128×320; "up" is the direction of travel.
 */
export function arrowTexture(value: string): THREE.CanvasTexture | null {
  const parts = value.split(';').map((s) => s.trim()).filter((s) => s && s !== 'none');
  if (!parts.length) return null;
  const key = parts.slice().sort().join(';');
  const hit = arrowCache.get(key);
  if (hit) return hit;

  const W = 128;
  const H = 320;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f0';
  g.strokeStyle = '#f4f4f0';
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
  const stem = 14;
  const cx = W / 2;
  const forkY = 150;

  const head = (x: number, y: number, angDeg: number) => {
    // Arrow head pointing toward angle (0 = up).
    g.save();
    g.translate(x, y);
    g.rotate((angDeg * Math.PI) / 180);
    g.beginPath();
    g.moveTo(0, -30);
    g.lineTo(-22, 8);
    g.lineTo(22, 8);
    g.closePath();
    g.fill();
    g.restore();
  };

  const merges = parts.filter((p) => p.startsWith('merge_to_'));
  const turns = parts.filter((p) => p in TURN_ANGLE);
  const reverse = parts.includes('reverse');

  if (turns.length || reverse) {
    // Stem
    g.lineWidth = stem;
    g.beginPath();
    g.moveTo(cx, H - 10);
    g.lineTo(cx, forkY);
    g.stroke();
    for (const t of turns) {
      const a = TURN_ANGLE[t];
      if (a === 0) {
        g.beginPath();
        g.moveTo(cx, forkY + 2);
        g.lineTo(cx, 50);
        g.stroke();
        head(cx, 40, 0);
        continue;
      }
      const rad = (a * Math.PI) / 180;
      const len = Math.abs(a) > 100 ? 40 : 48;
      const ex = cx + Math.sin(rad) * len;
      const ey = forkY - Math.cos(rad) * len;
      g.beginPath();
      g.moveTo(cx, forkY + stem / 2);
      g.lineTo(ex, ey);
      g.stroke();
      head(ex + Math.sin(rad) * 8, ey - Math.cos(rad) * 8, a);
    }
    if (reverse) {
      // U-turn hooks back down on the left (right-hand traffic convention).
      g.beginPath();
      g.arc(cx - 22, forkY, 22, 0, Math.PI, true);
      g.stroke();
      g.beginPath();
      g.moveTo(cx - 44, forkY);
      g.lineTo(cx - 44, forkY + 40);
      g.stroke();
      head(cx - 44, forkY + 58, 180);
    }
  }
  for (const m of merges) {
    const s = m === 'merge_to_left' ? -1 : 1;
    g.lineWidth = stem;
    g.beginPath();
    g.moveTo(cx - s * 24, H - 10);
    g.lineTo(cx - s * 24, 200);
    g.quadraticCurveTo(cx - s * 24, 120, cx + s * 22, 80);
    g.stroke();
    head(cx + s * 30, 70, s * 40);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  arrowCache.set(key, tex);
  return tex;
}

export type SignStyle = 'green' | 'blue';

export interface SignContent {
  destinations: string[];
  refs: string[];
  turn: string;
  style: SignStyle;
}

const signCache = new Map<string, THREE.CanvasTexture>();

function smallArrow(g: CanvasRenderingContext2D, x: number, y: number, turn: string) {
  const t = turn.split(';').find((p) => p in TURN_ANGLE);
  if (!t) return;
  g.save();
  g.translate(x, y);
  g.rotate((TURN_ANGLE[t] * Math.PI) / 180);
  g.fillStyle = '#fff';
  g.fillRect(-6, -10, 12, 40);
  g.beginPath();
  g.moveTo(0, -34);
  g.lineTo(-20, -6);
  g.lineTo(20, -6);
  g.closePath();
  g.fill();
  g.restore();
}

/** Overhead sign panel texture. Canvas 512×320 matches a 3.2 × 2.0 m panel. */
export function signTexture(s: SignContent): THREE.CanvasTexture {
  const key = JSON.stringify(s);
  const hit = signCache.get(key);
  if (hit) return hit;
  const W = 512;
  const H = 320;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const bg = s.style === 'blue' ? '#1d4f9c' : '#0b6b3a';
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#fff';
  g.lineWidth = 8;
  g.strokeRect(10, 10, W - 20, H - 20);

  let y = 36;
  if (s.refs.length) {
    g.font = 'bold 44px system-ui, sans-serif';
    let x = 30;
    for (const r of s.refs.slice(0, 3)) {
      const w = g.measureText(r).width + 28;
      g.fillStyle = s.style === 'blue' ? '#fff' : '#c8102e';
      g.fillRect(x, y, w, 58);
      g.fillStyle = s.style === 'blue' ? '#1d4f9c' : '#fff';
      g.fillText(r, x + 14, y + 46);
      x += w + 12;
    }
    y += 74;
  }
  const lines = s.destinations.slice(0, s.refs.length ? 3 : 4);
  const size = lines.length > 3 ? 40 : 46;
  g.font = `600 ${size}px system-ui, sans-serif`;
  g.fillStyle = '#fff';
  for (const d of lines) {
    let text = d;
    while (g.measureText(text).width > W - 120 && text.length > 3) text = text.slice(0, -2) + '…';
    g.fillText(text, 30, y + size);
    y += size + 12;
  }
  if (!lines.length && !s.refs.length) {
    g.font = 'italic 34px system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillText('(no destination)', 30, 70);
  }
  smallArrow(g, W - 52, H - 70, s.turn || 'through');

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  signCache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Lane symbols and small street furniture faces.

const miscCache = new Map<string, THREE.CanvasTexture>();

function cached(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const hit = miscCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  miscCache.set(key, tex);
  return tex;
}

/** Painted road text ("BUS", "30"), stretched along the lane like real carriageway lettering. */
export function roadTextTexture(text: string): THREE.CanvasTexture {
  return cached('text:' + text, 128, 256, (g) => {
    g.fillStyle = '#f4f4f0';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${text.length > 3 ? 44 : 56}px system-ui, sans-serif`;
    g.translate(64, 128);
    g.scale(1, 3.4);
    g.fillText(text, 0, 0);
  });
}

/** Painted bicycle symbol. */
export function bikeTexture(): THREE.CanvasTexture {
  return cached('bike', 128, 256, (g) => {
    g.strokeStyle = '#f4f4f0';
    g.lineWidth = 9;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Seen from above the lane, the bike is drawn side-on and stretched along the lane.
    g.translate(64, 128);
    g.scale(1, 1.7);
    const wheel = (x: number, y: number) => {
      g.beginPath();
      g.arc(x, y, 20, 0, Math.PI * 2);
      g.stroke();
    };
    wheel(-30, 30);
    wheel(30, 30);
    g.beginPath();
    g.moveTo(-30, 30);
    g.lineTo(-8, -6);
    g.lineTo(22, -6);
    g.lineTo(30, 30);
    g.moveTo(-8, -6);
    g.lineTo(4, 30);
    g.lineTo(22, -6);
    g.moveTo(-14, -18);
    g.lineTo(-2, -18);
    g.moveTo(22, -6);
    g.lineTo(18, -24);
    g.lineTo(30, -24);
    g.stroke();
  });
}

/** Front of a three-aspect traffic signal head. */
export function signalTexture(): THREE.CanvasTexture {
  return cached('signal', 64, 192, (g) => {
    g.fillStyle = '#16181a';
    g.fillRect(0, 0, 64, 192);
    const lamp = (y: number, c: string) => {
      g.fillStyle = c;
      g.beginPath();
      g.arc(32, y, 22, 0, Math.PI * 2);
      g.fill();
    };
    lamp(34, '#e53935');
    lamp(96, '#5a4a1c');
    lamp(158, '#1f4a2a');
  });
}

/** Face of a stop or give-way sign (transparent outside the sign shape). */
export function signFaceTexture(kind: 'stop' | 'give_way'): THREE.CanvasTexture {
  return cached('face:' + kind, 128, 128, (g) => {
    if (kind === 'stop') {
      g.fillStyle = '#c62828';
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = Math.PI / 8 + (i * Math.PI) / 4;
        g.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60);
      }
      g.closePath();
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = 5;
      g.stroke();
      g.fillStyle = '#fff';
      g.font = 'bold 38px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('STOP', 64, 66);
    } else {
      g.fillStyle = '#c62828';
      g.beginPath();
      g.moveTo(4, 10);
      g.lineTo(124, 10);
      g.lineTo(64, 118);
      g.closePath();
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(26, 24);
      g.lineTo(102, 24);
      g.lineTo(64, 92);
      g.closePath();
      g.fill();
    }
  });
}
