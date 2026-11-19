// Воркер сортировки. Держит позиции всех загруженных сплатов в уличных координатах,
// на каждый запрос: изгибает их в колесо (через LUT по s), отбрасывает невидимые по
// правилу «проявления» и по фрустуму, и сортирует оставшиеся от дальних к ближним
// (counting sort по 16-битному ключу глубины). Сортировка идёт по ИЗОГНУТЫМ позициям —
// иначе порядок смешивания на кольце был бы неверным.
import { DEFAULT_REVEAL, densityAlong, densitySeamParticle, smoothstep, wrap, type RevealParams, type Street } from './ring';

export const PAGE_BITS = 11;
const PAGE_MASK = (1 << PAGE_BITS) - 1;

interface WChunk {
  id: number;
  seg: number;
  partOnly: boolean;
  n: number;
  pos: Float32Array;
  rank: Uint16Array;
  alpha: Uint8Array;
  pages: Int32Array;
  rankMin: number; // 0..1
  s0: number;
  s1: number;
}

export interface SortRequest {
  type: 'sort';
  reqId: number;
  sCam: number;
  kappa: number;
  eye: [number, number, number];
  fwd: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  tanX: number;
  tanY: number;
  /** запас отсечения: pad[0] + pad[1]·глубина (м) — на величину сдвига парящих частиц */
  pad: [number, number];
  reveal: RevealParams;
  maxSorted: number;
}

export interface PickRequest {
  type: 'pick';
  reqId: number;
  sCam: number;
  kappa: number;
  origin: [number, number, number];
  dir: [number, number, number];
  reveal: RevealParams;
}

export type SortIn =
  | { type: 'init'; street: Street }
  | {
      type: 'add';
      id: number;
      seg: number;
      partOnly: boolean;
      pos: Float32Array;
      rank: Uint16Array;
      alpha: Uint8Array;
      pages: Int32Array;
      rankMin: number;
      s0: number;
      s1: number;
    }
  | { type: 'remove'; id: number }
  | { type: 'recycle'; buf: ArrayBuffer }
  | SortRequest
  | PickRequest;

export type SortOut =
  | { type: 'sorted'; reqId: number; count: number; buf: ArrayBuffer; ms: number; candidates: number; kept: number }
  | { type: 'picked'; reqId: number; hit: null | { s: number; h: number; w: number; dist: number } };

const BIN = 0.05;
let street: Street = { sMin: 0, sMax: 1, length: 1 };
const chunks = new Map<number, WChunk>();
let nb = 1;
let lutA = new Float32Array(1), lutB = lutA, lutS = lutA, lutC = lutA, lutD = lutA, lutP = lutA;
let depth = new Float32Array(0);
let idx = new Uint32Array(0);
let keys = new Uint16Array(0);
const counts = new Uint32Array(65536);
const spare: ArrayBuffer[] = [];

function ensureLut() {
  nb = Math.ceil(street.length / BIN) + 1;
  if (lutA.length !== nb) {
    lutA = new Float32Array(nb);
    lutB = new Float32Array(nb);
    lutS = new Float32Array(nb);
    lutC = new Float32Array(nb);
    lutD = new Float32Array(nb);
    lutP = new Float32Array(nb);
  }
}

function buildLut(sCam: number, kappa: number, r: RevealParams) {
  const L = street.length;
  for (let b = 0; b < nb; b++) {
    const s = street.sMin + (b + 0.5) * BIN;
    const d = wrap(s - sCam, L);
    const th = kappa * d;
    const sn = Math.sin(th), cs = Math.cos(th), hs = Math.sin(th * 0.5);
    const sinc = Math.abs(th) < 1e-6 ? 1 : sn / th;
    const cosc = Math.abs(th) < 1e-6 ? th * 0.5 : (2 * hs * hs) / th;
    lutA[b] = d * sinc;
    lutB[b] = d * cosc;
    lutS[b] = sn;
    lutC[b] = cs;
    lutD[b] = densityAlong(s, sCam, street, r).dens;
    lutP[b] = densitySeamParticle(s, sCam, street, r);
  }
}

function binOf(s: number): number {
  const L = street.length;
  let x = s - street.sMin;
  if (x < 0 || x >= L) x -= L * Math.floor(x / L);
  const b = (x / BIN) | 0;
  return b < 0 ? 0 : b >= nb ? nb - 1 : b;
}

function ensureScratch(n: number) {
  if (depth.length < n) {
    const cap = Math.ceil(n * 1.2);
    depth = new Float32Array(cap);
    idx = new Uint32Array(cap);
    keys = new Uint16Array(cap);
  }
}

function sort(req: SortRequest) {
  const t0 = performance.now();
  const r = req.reveal;
  buildLut(req.sCam, req.kappa, r);
  let total = 0;
  for (const c of chunks.values()) total += c.n;
  ensureScratch(total);

  const [ex, ey, ez] = req.eye;
  const [fx, fy, fz] = req.fwd;
  const [rx, ry, rz] = req.right;
  const [ux, uy, uz] = req.up;
  const tanX = req.tanX, tanY = req.tanY;
  const padA = req.pad[0], padB = req.pad[1];
  const latC = r.latCenter, latIn = r.latInner, latOut = r.latOuter, latD = r.latDensity;
  const margin = 0.03;
  let k = 0;
  let candidates = 0;
  let minD = Infinity, maxD = -Infinity;

  for (const c of chunks.values()) {
    let maxDens: number;
    if (c.partOnly) {
      maxDens = 0;
      for (let b = 0; b < nb; b += 8) if (lutP[b] > maxDens) maxDens = lutP[b];
    } else {
      maxDens = 0;
      const b0 = binOf(c.s0), b1 = binOf(c.s1 - 1e-3);
      for (let b = b0; b <= b1; b++) if (lutD[b] > maxDens) maxDens = lutD[b];
    }
    if (c.rankMin > maxDens + margin) continue;
    candidates += c.n;
    const lut = c.partOnly ? lutP : lutD;
    const pos = c.pos, rank = c.rank, pages = c.pages, n = c.n, partOnly = c.partOnly;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const s = pos[i3], h = pos[i3 + 1], w = pos[i3 + 2];
      const b = binOf(s);
      let dens = lut[b];
      if (!partOnly) {
        const aw = Math.abs(w - latC);
        if (aw > latIn) {
          const t = aw >= latOut ? 1 : smoothstep(latIn, latOut, aw);
          const ld = 1 + (latD - 1) * t;
          if (ld < dens) dens = ld;
        }
      }
      if (rank[i] > (dens + margin) * 65535) continue;
      const vx = lutA[b] - h * lutS[b] - ex;
      const vy = lutB[b] + h * lutC[b] - ey;
      const vz = w - ez;
      const dz = fx * vx + fy * vy + fz * vz;
      if (dz < 0.12) continue;
      const pad = padA + padB * dz;
      const dx = rx * vx + ry * vy + rz * vz;
      if (dx > dz * tanX + pad || -dx > dz * tanX + pad) continue;
      const dy = ux * vx + uy * vy + uz * vz;
      if (dy > dz * tanY + pad || -dy > dz * tanY + pad) continue;
      depth[k] = dz;
      idx[k] = (pages[i >> PAGE_BITS] << PAGE_BITS) | (i & PAGE_MASK);
      if (dz < minD) minD = dz;
      if (dz > maxD) maxD = dz;
      k++;
    }
  }

  // counting sort: ключ 0 — самый дальний
  counts.fill(0);
  const range = Math.max(maxD - minD, 1e-3);
  const sc = 65535 / range;
  for (let i = 0; i < k; i++) {
    const key = ((maxD - depth[i]) * sc) | 0;
    keys[i] = key;
    counts[key]++;
  }
  let acc = 0;
  for (let j = 0; j < 65536; j++) {
    const c = counts[j];
    counts[j] = acc;
    acc += c;
  }
  // при перегрузе отрезаем самые дальние (это только частицы)
  const drop = Math.max(0, k - req.maxSorted);
  const outCount = k - drop;
  let buf = spare.pop();
  if (!buf || buf.byteLength < outCount * 4) buf = new ArrayBuffer(Math.ceil(Math.max(outCount, 1024) * 1.25) * 4);
  const out = new Uint32Array(buf);
  for (let i = 0; i < k; i++) {
    const p = counts[keys[i]]++ - drop;
    if (p >= 0) out[p] = idx[i];
  }
  const msg: SortOut = { type: 'sorted', reqId: req.reqId, count: outCount, buf, ms: performance.now() - t0, candidates, kept: k };
  (self as unknown as Worker).postMessage(msg, [buf]);
}

function pick(req: PickRequest) {
  const r = req.reveal;
  buildLut(req.sCam, req.kappa, r);
  const [ox, oy, oz] = req.origin;
  const [dx, dy, dz] = req.dir;
  // собираем сплаты возле луча и ищем, где накопленная непрозрачность пересекает порог —
  // так же, как глаз видит поверхность из множества полупрозрачных сплатов
  const hits: { t: number; a: number; s: number; h: number; w: number }[] = [];
  for (const c of chunks.values()) {
    if (c.partOnly) continue;
    const pos = c.pos, rank = c.rank, alpha = c.alpha, n = c.n;
    for (let i = 0; i < n; i++) {
      if (alpha[i] < 5) continue;
      const s = pos[i * 3], h = pos[i * 3 + 1], w = pos[i * 3 + 2];
      const b = binOf(s);
      if (rank[i] > lutD[b] * 65535) continue;
      const vx = lutA[b] - h * lutS[b] - ox;
      const vy = lutB[b] + h * lutC[b] - oy;
      const vz = w - oz;
      const t = vx * dx + vy * dy + vz * dz;
      if (t < 0.5) continue;
      const rr = 0.05 + t * 0.01;
      const perp2 = vx * vx + vy * vy + vz * vz - t * t;
      if (perp2 < rr * rr) hits.push({ t, a: (alpha[i] / 255) * Math.exp(-perp2 / (rr * rr)), s, h, w });
    }
  }
  hits.sort((a, b) => a.t - b.t);
  let trans = 1;
  let best: { s: number; h: number; w: number; dist: number } | null = null;
  for (const hh of hits) {
    trans *= 1 - hh.a;
    if (1 - trans >= 0.4) {
      best = { s: hh.s, h: hh.h, w: hh.w, dist: hh.t };
      break;
    }
  }
  if (!best && hits.length) {
    const hh = hits.reduce((m, x) => (x.a > m.a ? x : m));
    best = { s: hh.s, h: hh.h, w: hh.w, dist: hh.t };
  }
  (self as unknown as Worker).postMessage({ type: 'picked', reqId: req.reqId, hit: best } satisfies SortOut);
}

self.onmessage = (e: MessageEvent<SortIn>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      street = m.street;
      ensureLut();
      buildLut(0, 0, DEFAULT_REVEAL);
      break;
    case 'add':
      chunks.set(m.id, {
        id: m.id,
        seg: m.seg,
        partOnly: m.partOnly,
        n: m.rank.length,
        pos: m.pos,
        rank: m.rank,
        alpha: m.alpha,
        pages: m.pages,
        rankMin: m.rankMin,
        s0: m.s0,
        s1: m.s1,
      });
      break;
    case 'remove':
      chunks.delete(m.id);
      break;
    case 'recycle':
      if (spare.length < 3) spare.push(m.buf);
      break;
    case 'sort':
      sort(m);
      break;
    case 'pick':
      pick(m);
      break;
  }
};
