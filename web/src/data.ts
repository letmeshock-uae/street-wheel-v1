// Формат данных, который пишет tools/build_ring.py.

export interface TierInfo {
  count: number;
  file: string | null;
  bytes?: number;
}

export interface SegmentInfo {
  id: number;
  s0: number;
  s1: number;
  bmin: [number, number, number];
  ext: [number, number, number];
  count: number;
  tiers: TierInfo[];
}

export interface Manifest {
  version: number;
  count: number;
  street: {
    sMin: number;
    sMax: number;
    length: number;
    wMin: number;
    wMax: number;
    hMax: number;
    corridor: [number, number];
    seamWidth: number;
  };
  modelToStreet: { matrix: number[][]; groundS: number[]; groundH: number[] };
  quant: { scaleLogMin: number; scaleLogMax: number };
  tierRanks: number[];
  segments: SegmentInfo[];
  seam: { id: number; count: number; bmin: [number, number, number]; ext: [number, number, number]; file: string; bytes: number };
  base: { file: string; bytes: number; chunks: { seg: number; tier: number; offset: number; count: number }[] };
}

/** Раскодированный кусок: готовые данные для GPU и для сортировки. */
export interface DecodedChunk {
  seg: number;
  tier: number; // -1 — частицы шва
  count: number;
  texA: Uint32Array; // 4 u32 на сплат: [x16|y16], [z16|rank16], rgba8, quat8x4
  texB: Uint32Array; // 1 u32 на сплат: sx8|sy8|sz8|seg8
  pos: Float32Array; // уличные координаты (s,h,w), для сортировки/пикинга
  rank: Uint16Array; // глобальный ранг в сегменте (0..65535)
  alpha: Uint8Array;
}

export const BYTES_PER_SPLAT = 18;

/**
 * raw — распакованные байты; offset — начало куска; layout (планарный):
 *   3×u16 позиции (дельты в мортон-порядке), u8 ранг внутри тира, 4×u8 rgba, 3×u8 log-scale, 4×u8 quat
 */
export function decodeChunk(
  raw: ArrayBuffer,
  offset: number,
  count: number,
  seg: number,
  tier: number,
  bmin: number[],
  ext: number[],
  rank0: number,
  rank1: number,
): DecodedChunk {
  const m = count;
  const u8 = new Uint8Array(raw, offset, m * BYTES_PER_SPLAT);
  // u16-планы: offset всегда чётный (кратен 18·m)
  const p16 = new Uint16Array(raw, offset, m * 3);
  const rk = u8.subarray(6 * m, 7 * m);
  const cr = u8.subarray(7 * m, 8 * m);
  const cg = u8.subarray(8 * m, 9 * m);
  const cb = u8.subarray(9 * m, 10 * m);
  const ca = u8.subarray(10 * m, 11 * m);
  const sx = u8.subarray(11 * m, 12 * m);
  const sy = u8.subarray(12 * m, 13 * m);
  const sz = u8.subarray(13 * m, 14 * m);
  const q0 = u8.subarray(14 * m, 15 * m);
  const q1 = u8.subarray(15 * m, 16 * m);
  const q2 = u8.subarray(16 * m, 17 * m);
  const q3 = u8.subarray(17 * m, 18 * m);

  const texA = new Uint32Array(m * 4);
  const texB = new Uint32Array(m);
  const pos = new Float32Array(m * 3);
  const rank = new Uint16Array(m);
  const alpha = new Uint8Array(m);

  const ex = ext[0] / 65535, ey = ext[1] / 65535, ez = ext[2] / 65535;
  const bx = bmin[0], by = bmin[1], bz = bmin[2];
  const rs = (rank1 - rank0) / 256;
  let x = 0, y = 0, z = 0;
  const segBits = (seg & 255) << 24;
  for (let i = 0; i < m; i++) {
    x = (x + p16[i]) & 0xffff;
    y = (y + p16[m + i]) & 0xffff;
    z = (z + p16[2 * m + i]) & 0xffff;
    const r = rank0 + (rk[i] + 0.5) * rs;
    const r16 = Math.min(65535, Math.max(0, Math.round(r * 65535)));
    const j = i * 4;
    texA[j] = x | (y << 16);
    texA[j + 1] = z | (r16 << 16);
    texA[j + 2] = cr[i] | (cg[i] << 8) | (cb[i] << 16) | (ca[i] << 24);
    texA[j + 3] = q0[i] | (q1[i] << 8) | (q2[i] << 16) | (q3[i] << 24);
    texB[i] = sx[i] | (sy[i] << 8) | (sz[i] << 16) | segBits;
    const k = i * 3;
    pos[k] = bx + x * ex;
    pos[k + 1] = by + y * ey;
    pos[k + 2] = bz + z * ez;
    rank[i] = r16;
    alpha[i] = ca[i];
  }
  return { seg, tier, count: m, texA, texB, pos, rank, alpha };
}

/**
 * Качает файл и распаковывает gzip нативным DecompressionStream.
 * Если хостинг сам отдал файл с Content-Encoding: gzip (браузер уже распаковал) — магии 1f8b не будет,
 * тогда используем байты как есть.
 */
export async function fetchGunzip(url: string, onProgress?: (loaded: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded);
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.byteLength;
  }
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf.buffer;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).arrayBuffer();
}
