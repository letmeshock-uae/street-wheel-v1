// Общая математика «улицы-колеса». Используется и в главном потоке (сноски, пикинг),
// и в воркере сортировки. Те же формулы продублированы в GLSL (shaders.ts) — держите синхронно.
//
// Уличные координаты: s — вдоль улицы, h — вверх от земли, w — поперёк (вправо).
// Мир: камера стоит на «дне» колеса в X=0, смотрит в +X, вверх +Y, вправо +Z.
// Изгиб с кривизной kappa (0 — прямая улица, 2π/L — замкнутое колесо):
//   d  = wrap(s - sCam)           — расстояние вдоль улицы до камеры, [-L/2, L/2)
//   θ  = kappa·d
//   X  = d·sinθ/θ − h·sinθ
//   Y  = d·(1−cosθ)/θ + h·cosθ
//   Z  = w
// Якобиан: ∂P/∂s = (1−h·kappa)(cosθ, sinθ, 0), ∂P/∂h = (−sinθ, cosθ, 0), ∂P/∂w = (0,0,1).

export interface Street {
  sMin: number;
  sMax: number;
  length: number;
}

export function wrap(d: number, L: number): number {
  return d - L * Math.floor(d / L + 0.5);
}

/** Переводит уличную точку в мировые координаты при данном положении камеры и кривизне. */
export function bendPoint(s: number, h: number, w: number, sCam: number, kappa: number, L: number, out: number[] | Float32Array, o = 0): void {
  const d = wrap(s - sCam, L);
  const th = kappa * d;
  const sn = Math.sin(th);
  const cs = Math.cos(th);
  const hs = Math.sin(th * 0.5);
  const sinc = Math.abs(th) < 1e-6 ? 1 : sn / th;
  const cosc = Math.abs(th) < 1e-6 ? th * 0.5 : (2 * hs * hs) / th;
  out[o] = d * sinc - h * sn;
  out[o + 1] = d * cosc + h * cs;
  out[o + 2] = w;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Параметры «проявления»: чем ближе к зрителю, тем больше деталей.
 * Все расстояния — в метрах вдоль улицы. Эти же числа уходят в шейдер как uniform'ы.
 */
export interface RevealParams {
  densNear: number; // до этого расстояния — все сплаты; дальше плотность ∝ (densNear/d)^densPow
  densPow: number; // крутизна спада (1 — гипербола: «дизеринг» как на референсе)
  farDensity: number; // нижний предел доли сплатов (частицы над головой)
  densFar: number; // масштаб спада частиц шва
  partNear: number; // где сплат начинает «сжиматься» в точку
  partFar: number; // где он уже точка
  seamInner: number; // ближе к концу улицы — полностью растворено
  seamOuter: number; // дальше от конца — нетронуто
  seamDensity: number;
  seamPDensNear: number; // плотность частиц шва рядом со зрителем
  seamPDensFar: number;
  seamWidth: number; // полуширина зоны шва (из manifest)
  latCenter: number; // центр коридора улицы (w)
  latInner: number; // поперечное расстояние, где начинается растворение
  latOuter: number;
  latDensity: number;
}

export const DEFAULT_REVEAL: RevealParams = {
  densNear: 9,
  densPow: 1.5,
  farDensity: 0.02,
  densFar: 95,
  partNear: 14,
  partFar: 62,
  seamInner: 3,
  seamOuter: 32,
  seamDensity: 0.05,
  seamPDensNear: 1.0,
  seamPDensFar: 0.3,
  seamWidth: 34,
  latCenter: -7,
  latInner: 40,
  latOuter: 62,
  latDensity: 0.12,
};

/** Базовая кривая: 1 рядом, дальше (densNear/d)^densPow, не ниже farDensity. */
export function densityCurve(ad: number, r: RevealParams): number {
  return Math.max(r.farDensity, Math.min(1, Math.pow(r.densNear / Math.max(ad, 1e-3), r.densPow)));
}

/** Плотность (доля видимых сплатов по рангу) для обычного сплата — без поперечной составляющей. */
export function densityAlong(s: number, sCam: number, st: Street, r: RevealParams): { dens: number; pf: number } {
  const ad = Math.abs(wrap(s - sCam, st.length));
  let dens = densityCurve(ad, r);
  const de = Math.min(s - st.sMin, st.sMax - s);
  const sm = 1 - smoothstep(r.seamInner, r.seamOuter, de);
  dens = Math.min(dens, 1 + (r.seamDensity - 1) * sm);
  const pf = Math.max(smoothstep(r.partNear, r.partFar, ad), sm);
  return { dens, pf };
}

export function densityLateral(w: number, r: RevealParams): number {
  const lt = smoothstep(r.latInner, r.latOuter, Math.abs(w - r.latCenter));
  return 1 + (r.latDensity - 1) * lt;
}

/** Плотность частиц шва (они всегда точки). */
export function densitySeamParticle(s: number, sCam: number, st: Street, r: RevealParams): number {
  const ad = Math.abs(wrap(s - sCam, st.length));
  const t = smoothstep(r.partNear * 0.5, r.densFar, ad);
  const dens = r.seamPDensNear + (r.seamPDensFar - r.seamPDensNear) * t;
  const e = Math.abs(wrap(s - st.sMax, st.length));
  const edge = 1 - smoothstep(r.seamWidth * 0.75, r.seamWidth + 4, e);
  return dens * edge;
}
