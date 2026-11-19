// Цитата из частиц вдоль всего кольца. Пять фраз стоят через равные промежутки в разных
// плоскостях (посреди улицы, на стенах, над головой, наискосок), а последняя — «Everything else
// is secondary.» — лежит на асфальте поперёк пути, ровно на шве. Каждая надпись «пишется» по мере
// приближения в порядке чтения: порядок лежит в ранге точки; вдали — редкая пыль, при проходе
// сквозь надпись она снова рассыпается.
import '@fontsource-variable/geist';
import type { DecodedChunk } from './data';

/** Фразы по порядку пути: от шва вперёд. Последняя строка — на шве. */
const QUOTE = [
  "Your time is limited, so don't waste it living someone else's life.",
  "Don't be trapped by dogma — which is living with the results of other people's thinking.",
  "Don't let the noise of other's opinions drown out your own inner voice.",
  'And most important, have the courage to follow your heart and intuition.',
  'They somehow already know what you truly want to become.',
];
const LAST = ['Everything else', 'is secondary.'];

const INK = '#ffffff';
const FAMILY = 'Geist Variable';
const FONT = `"${FAMILY}", "Geist", "Helvetica Neue", Helvetica, Arial, sans-serif`;

export interface ParticleTextSpec {
  sMin: number;
  sMax: number;
  length: number; // длина кольца (м)
  lane: number; // ось полосы, по которой идёт камера (w)
  mpp: number; // метров на пиксель холста — чёткость букв
  segId: number;
  scaleLogMin: number;
  scaleLogMax: number;
}

export interface ParticleText {
  chunk: DecodedChunk;
  bmin: [number, number, number];
  ext: [number, number, number];
}

type Ctx2 = CanvasRenderingContext2D & { letterSpacing?: string };

/** Холст одной надписи с примитивами в метрах; zones — порядок «написания». */
class Panel {
  readonly cv: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly halftones: { x: number; y: number; w: number; h: number }[] = [];
  readonly zones: { x: number; y: number; w: number; h: number }[] = [];
  readonly P: number;
  constructor(readonly wM: number, readonly hM: number, mpp: number) {
    this.P = 1 / mpp;
    this.cv = document.createElement('canvas');
    this.cv.width = Math.max(1, Math.round(wM * this.P));
    this.cv.height = Math.max(1, Math.round(hM * this.P));
    this.ctx = this.cv.getContext('2d', { willReadFrequently: true })!;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    this.ctx.textBaseline = 'alphabetic';
  }
  m = (v: number) => v * this.P;
  font(sizeM: number, weight: number) {
    return `${weight} ${this.m(sizeM).toFixed(1)}px ${FONT}`;
  }
  text(t: string, x: number, y: number, size: number, weight = 600, align: CanvasTextAlign = 'left') {
    const c = this.ctx as Ctx2;
    c.font = this.font(size, weight);
    c.fillStyle = INK;
    c.textAlign = align;
    const mt = c.measureText(t);
    c.fillText(t, this.m(x), this.m(y));
    c.textAlign = 'left';
    const w = mt.width, px = this.m(x) - (align === 'center' ? w / 2 : align === 'right' ? w : 0);
    const asc = mt.actualBoundingBoxAscent || this.m(size) * 0.8, desc = mt.actualBoundingBoxDescent || this.m(size) * 0.25;
    this.zones.push({ x: px - 2, y: this.m(y) - asc - 2, w: w + 4, h: asc + desc + 4 });
  }
  /** размер шрифта, при котором строка влезает в maxW (не больше size) */
  fit(t: string, size: number, maxW: number, weight = 700) {
    this.ctx.font = this.font(size, weight);
    const w = this.ctx.measureText(t).width / this.P;
    return w > maxW ? (size * maxW) / w : size;
  }
  wrap(t: string, size: number, maxW: number, weight: number) {
    this.ctx.font = this.font(size, weight);
    const lines: string[] = [];
    let line = '';
    for (const w of t.split(/\s+/)) {
      const test = line ? line + ' ' + w : w;
      if (this.ctx.measureText(test).width > this.m(maxW) && line) {
        lines.push(line);
        line = w;
      } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  /** абзац; y — базовая линия первой строки */
  para(t: string, x: number, y: number, size: number, maxW: number, lh: number, weight: number, align: CanvasTextAlign = 'left') {
    const lines = this.wrap(t, size, maxW, weight);
    lines.forEach((l, i) => this.text(l, x, y + i * size * lh, size, weight, align));
    return lines.length * size * lh;
  }
  /** крупный текст в этой области — блоками 2×2 (вчетверо меньше точек) */
  halftone(x: number, y: number, w: number, h: number) {
    this.halftones.push({ x: Math.floor(this.m(x)), y: Math.floor(this.m(y)), w: Math.ceil(this.m(w)), h: Math.ceil(this.m(h)) });
  }
}

/** Где стоит надпись: s, h, w — центр; yaw/tilt — плоскость (градусы); stretch — растяжение по «вверх» холста. */
interface Place {
  s: number;
  h: number;
  w: number;
  yaw?: number;
  tilt?: number;
  stretch?: number;
}

/** кватернион (w, x, y, z) поворота, у которого локальные оси: x — нормаль, y — V, z — U; упакован по байту */
function packQuat(U: number[], V: number[]): number {
  const N = [V[1] * U[2] - V[2] * U[1], V[2] * U[0] - V[0] * U[2], V[0] * U[1] - V[1] * U[0]];
  const m00 = N[0], m10 = N[1], m20 = N[2], m01 = V[0], m11 = V[1], m21 = V[2], m02 = U[0], m12 = U[1], m22 = U[2];
  let w: number, x: number, y: number, z: number;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const b = (v: number) => Math.max(0, Math.min(255, Math.round((v + 1) * 127.5)));
  return (b(w) | (b(x) << 8) | (b(y) << 16) | (b(z) << 24)) >>> 0;
}

/** Метры от шва, на которых стоят фразы: равные доли кольца, последняя — на самом шве. */
export function quoteStops(L: number): number[] {
  const n = QUOTE.length + 1;
  return QUOTE.map((_, i) => (L * (i + 1)) / n);
}

export async function buildParticleText(sp: ParticleTextSpec): Promise<ParticleText> {
  try {
    await Promise.all(['500', '600', '700'].map((w) => document.fonts.load(`${w} 100px "${FAMILY}"`, QUOTE.join(' '))));
  } catch {
    /* запасной шрифт тоже подойдёт */
  }
  const mpp = sp.mpp;
  const C = sp.lane;
  const stops = quoteStops(sp.length).map((x) => sp.sMin + x);
  const scene: { panel: Panel; at: Place }[] = [];
  const tmp = new Panel(1, 1, mpp);
  const linesOf = (t: string, size: number, maxW: number, weight: number) => tmp.wrap(t, size, maxW, weight).length;

  // крупная фраза на отдельной панели: строки по центру, буквы — полутоном
  const block = (t: string, PW: number, size: number, at: (hM: number) => Place) => {
    const lh = 1.12, pad = 0.4;
    const n = linesOf(t, size, PW - 2 * pad, 600);
    const hM = n * size * lh + 2 * pad;
    const p = new Panel(PW, hM, mpp);
    p.para(t, PW / 2, pad + size * 0.92, size, PW - 2 * pad, lh, 600, 'center');
    p.halftone(0, 0, PW, hM);
    scene.push({ panel: p, at: at(hM) });
  };

  // длинная строка на стене, читается на ходу
  const wall = (t: string, s: number, side: -1 | 1, size = 1.5, len = 22) => {
    const lh = 1.22;
    const n = linesOf(t, size, len - 1, 600);
    const p = new Panel(len, n * size * lh + 0.8, mpp);
    p.para(t, 0.4, size * 1.05, size, len - 1, lh, 600);
    // левая сторона: текст идёт вперёд (+s), правая — назад; обе читаются слева направо с улицы.
    // Панели не вплотную к стене, а развёрнуты к идущему (65° вместо 90°), как раскрытая книга
    scene.push({ panel: p, at: { s, w: C + side * 9.5, h: 4.6, yaw: side < 0 ? 65 : -65 } });
  };

  // 1 · посреди улицы, лицом к идущему
  block(QUOTE[0], 22, 2.1, (hM) => ({ s: stops[0], w: C, h: 1.0 + hM / 2 }));
  // 2 · слева, вдоль улицы
  wall(QUOTE[1], stops[1], -1);
  // 3 · справа, вдоль улицы
  wall(QUOTE[2], stops[2], 1);
  // 4 · над головой: висит над улицей, наклонена верхом к идущему
  block(QUOTE[3], 24, 1.9, () => ({ s: stops[3], w: C, h: 8.0, tilt: 28 }));
  // 5 · наискосок слева, развёрнута к идущему
  block(QUOTE[4], 18, 1.8, (hM) => ({ s: stops[4], w: C - 9, h: 1.0 + hM / 2, yaw: -35 }));

  // 6 · на шве: лежит на асфальте поперёк пути, вытянута вдоль улицы, как разметка
  {
    const FW = 16;
    const [l0, l1] = LAST;
    const sz = Math.min(tmp.fit(l0, 2.8, FW), tmp.fit(l1, 2.8, FW));
    const y0 = 0.5 + sz * 0.78, y1 = y0 + sz * 1.08;
    const p = new Panel(FW + 1, y1 + 0.5 + sz * 0.22, mpp);
    p.text(l0, (FW + 1) / 2, y0, sz, 700, 'center');
    p.text(l1, (FW + 1) / 2, y1, sz, 700, 'center');
    p.halftone(0, 0, FW + 1, p.hM);
    scene.push({ panel: p, at: { s: sp.sMax, w: C, h: 0.06, tilt: -90, stretch: 2.6 } });
  }

  // ---- холсты → точки
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], sgU: number[] = [], sgV: number[] = [];
  const cols: number[] = [], als: number[] = [], ords: number[] = [], quats: number[] = [];
  for (const { panel: p, at: pl } of scene) {
    const yaw = ((pl.yaw ?? 0) * Math.PI) / 180, tilt = ((pl.tilt ?? 0) * Math.PI) / 180;
    const stretch = pl.stretch ?? 1;
    // базис плоскости в уличных координатах (s, h, w): U — вправо по холсту, V — вверх по холсту
    const U = [Math.sin(yaw), 0, Math.cos(yaw)];
    const V = [-Math.sin(tilt) * Math.cos(yaw), Math.cos(tilt), Math.sin(tilt) * Math.sin(yaw)];
    const quat = packQuat(U, V);
    const W = p.cv.width, H = p.cv.height;
    const data = p.ctx.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (const r of p.halftones)
      for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.h); y++) mask.fill(1, y * W + Math.max(0, r.x), y * W + Math.min(W, r.x + r.w));
    const nz = Math.max(1, p.zones.length);
    // порядок «написания»: строка за строкой, внутри строки — слева направо
    const orderAt = (px: number, py: number) => {
      for (let zi = p.zones.length - 1; zi >= 0; zi--) {
        const z = p.zones[zi];
        if (px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h) return (zi + Math.min(1, Math.max(0, (px - z.x) / Math.max(1, z.w))) * 0.85) / nz;
      }
      return 0.98;
    };
    const push = (px: number, py: number, sigmaM: number, a: number) => {
      ords.push(Math.min(1, Math.max(0, orderAt(px, py) + (Math.random() - 0.5) * 0.02)));
      const j = (sigmaM / mpp) * 0.3; // лёгкий разброс — не сетка
      const u = (px + (Math.random() - 0.5) * j) * mpp - p.wM / 2;
      const v = (p.hM / 2 - (py + (Math.random() - 0.5) * j) * mpp) * stretch;
      xs.push(pl.s + U[0] * u + V[0] * v);
      ys.push(pl.h + U[1] * u + V[1] * v);
      zs.push(pl.w + U[2] * u + V[2] * v);
      sgU.push(sigmaM);
      sgV.push(sigmaM * stretch);
      cols.push(0xffffff);
      als.push(Math.max(0, Math.min(255, Math.round(a * 255))));
      quats.push(quat);
    };
    const inkAt = (i: number) => (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    const K = 2;
    for (const r of p.halftones)
      for (let y = r.y; y < r.y + r.h - K + 1; y += K)
        for (let x = r.x; x < r.x + r.w - K + 1; x += K) {
          let ink = 0, n = 0;
          for (let yy = y; yy < y + K; yy++)
            for (let xx = x; xx < x + K; xx++) {
              if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
              ink += inkAt((yy * W + xx) * 4);
              n++;
            }
          if (!n) continue;
          const cov = Math.min(1, ink / n);
          if (cov < 0.1) continue;
          push(x + K / 2, y + K / 2, 0.72 * K * mpp * Math.sqrt(Math.min(1, cov * 1.15)), 1);
        }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const q = y * W + x;
        if (mask[q]) continue;
        const ink = inkAt(q * 4);
        if (ink < 0.28) continue;
        push(x + 0.5, y + 0.5, 0.8 * mpp, Math.min(1, ink * 1.3));
      }
  }

  // ---- коробка по фактическим точкам (с запасом) — в ней квантуются позиции
  const n = xs.length;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    lo[0] = Math.min(lo[0], xs[i]); hi[0] = Math.max(hi[0], xs[i]);
    lo[1] = Math.min(lo[1], ys[i]); hi[1] = Math.max(hi[1], ys[i]);
    lo[2] = Math.min(lo[2], zs[i]); hi[2] = Math.max(hi[2], zs[i]);
  }
  const bmin: [number, number, number] = [lo[0] - 0.5, lo[1] - 0.5, lo[2] - 0.5];
  const ext: [number, number, number] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];

  // ---- упаковка — тот же формат, что у кусков улицы; ранг точки = её порядок «написания»
  const texA = new Uint32Array(n * 4);
  const texB = new Uint32Array(n);
  const pos = new Float32Array(n * 3);
  const rank = new Uint16Array(n);
  const alpha = new Uint8Array(n);
  const ls = (v: number) => Math.max(0, Math.min(255, Math.round(((Math.log(Math.max(v, 1e-6)) - sp.scaleLogMin) / (sp.scaleLogMax - sp.scaleLogMin)) * 255)));
  const flat = ls(0.002);
  const q16 = (v: number, b: number, e: number) => Math.max(0, Math.min(65535, Math.round(((v - b) / e) * 65535)));
  for (let i = 0; i < n; i++) {
    const qx = q16(xs[i], bmin[0], ext[0]), qy = q16(ys[i], bmin[1], ext[1]), qz = q16(zs[i], bmin[2], ext[2]);
    const r16 = Math.round(ords[i] * 65535);
    const j = i * 4;
    texA[j] = qx | (qy << 16);
    texA[j + 1] = qz | (r16 << 16);
    texA[j + 2] = (cols[i] | (als[i] << 24)) >>> 0;
    texA[j + 3] = quats[i];
    // оси точки: x — нормаль (плоская), y — «вверх» холста, z — «вправо» холста
    texB[i] = flat | (ls(sgV[i]) << 8) | (ls(sgU[i]) << 16) | ((sp.segId & 255) << 24);
    pos[i * 3] = bmin[0] + (qx / 65535) * ext[0];
    pos[i * 3 + 1] = bmin[1] + (qy / 65535) * ext[1];
    pos[i * 3 + 2] = bmin[2] + (qz / 65535) * ext[2];
    rank[i] = r16;
    alpha[i] = als[i];
  }
  return { chunk: { seg: sp.segId, tier: -2, count: n, texA, texB, pos, rank, alpha }, bmin, ext };
}
