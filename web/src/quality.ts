// Профили качества + адаптация на лету по времени кадра.

export type QualityName = 'low' | 'mid' | 'high';

export interface QualityProfile {
  name: QualityName;
  poolSplats: number; // ёмкость GPU-пула (≈20 байт/сплат)
  maxRank: number; // доля сплатов, выше которой детали не грузим вообще (1 — всё)
  radius: number; // множитель радиусов «проявления»
  dprMax: number;
  maxSorted: number; // жёсткий потолок сплатов в кадре
}

export const PROFILES: Record<QualityName, QualityProfile> = {
  low: { name: 'low', poolSplats: 1_300_000, maxRank: 0.4, radius: 0.62, dprMax: 1.25, maxSorted: 700_000 },
  mid: { name: 'mid', poolSplats: 2_600_000, maxRank: 0.7, radius: 0.82, dprMax: 1.5, maxSorted: 1_400_000 },
  high: { name: 'high', poolSplats: 4_600_000, maxRank: 1, radius: 1.0, dprMax: 2, maxSorted: 2_600_000 },
};

export function detectQuality(): { name: QualityName; gpu: string } {
  const forced = new URLSearchParams(location.search).get('q') as QualityName | null;
  let gpu = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* ignore */
  }
  if (forced && forced in PROFILES) return { name: forced, gpu };
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const strong = /Apple M\d|RTX|Radeon RX|Radeon Pro|GeForce GTX (10[6-9]|16)|Arc A/i.test(gpu);
  const weak = /Intel|UHD|Iris|Mali|Adreno|PowerVR|SwiftShader|llvmpipe/i.test(gpu);
  if (mobile || mem <= 4) return { name: 'low', gpu };
  if (strong) return { name: 'high', gpu };
  if (weak) return { name: 'mid', gpu };
  return { name: 'mid', gpu };
}

/** Следит за временем кадра: сначала снижает разрешение, потом радиус деталей; медленно возвращает обратно. */
export class Adaptive {
  renderScale = 1;
  detail = 1;
  private ema = 16.7;
  private sortEma = 10;
  private acc = 0;
  private lastDown = -1e9;
  private time = 0;
  frozen = false;

  frame(dtMs: number, sortMs: number | null) {
    // паузы (фоновая вкладка, троттлинг, отладчик) — не повод снижать качество
    if (dtMs > 200) return;
    this.time += dtMs;
    this.ema += (Math.min(dtMs, 100) - this.ema) * 0.08;
    if (sortMs != null) this.sortEma += (sortMs - this.sortEma) * 0.2;
    this.acc += dtMs;
    if (this.acc < 1000 || this.frozen) return;
    this.acc = 0;
    const slow = this.ema > 24 || this.sortEma > 70;
    if (slow) {
      if (this.ema > 24 && this.renderScale > 0.7) this.renderScale = Math.max(0.7, this.renderScale - 0.1);
      else this.detail = Math.max(0.45, this.detail - 0.1);
      this.lastDown = this.time;
    } else if (this.ema < 18.5 && this.sortEma < 40 && this.time - this.lastDown > 5000) {
      if (this.detail < 1) this.detail = Math.min(1, this.detail + 0.05);
      else if (this.renderScale < 1) this.renderScale = Math.min(1, this.renderScale + 0.05);
    }
  }

  get fps() {
    return 1000 / this.ema;
  }
}
