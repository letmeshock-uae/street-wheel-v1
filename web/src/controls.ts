// Скролл/тач/клавиатура → движение по кругу; мышь/драг → взгляд.

const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Controls {
  s = 0; // неограниченная позиция вдоль улицы (метры)
  sTarget = 0;
  velocity = 0; // м/с, сглаженная
  yaw = 0;
  pitch = 0;
  basePitch = 0.14;
  interacted = false;
  enabled = true;
  /** параллакс за курсором (в режиме разметки выключаем, чтобы клик попадал точно) */
  mouseLook = true;
  /** Метров на пиксель скролла */
  wheelGain = 0.022;
  /** Отклик: насколько быстро позиция догоняет скролл (1/с) */
  smoothing = 4.5;

  private lookX = 0; // −1..1 позиция мыши
  private lookY = 0;
  private dragYaw = 0;
  private dragPitch = 0;
  private dragging = false;
  private lastPointer: { x: number; y: number } | null = null;
  private touch: { x: number; y: number; t: number; vx: number; vy: number; axis: 'none' | 'walk' | 'look' } | null = null;
  private inertia = 0; // м/с после отпускания пальца
  private keyVel = 0;
  private keys = new Set<string>();

  constructor(el: HTMLElement) {
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('touchstart', this.onTouchStart, { passive: false });
    el.addEventListener('touchmove', this.onTouchMove, { passive: false });
    el.addEventListener('touchend', this.onTouchEnd);
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input,textarea,[contenteditable]')) return;
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'PageDown' || e.key === ' ') this.nudge(14);
        else if (e.key === 'PageUp') this.nudge(-14);
        else this.keys.add(e.key);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private nudge(m: number) {
    if (!this.enabled) return;
    this.interacted = true;
    this.sTarget += m;
    this.clampTarget();
  }

  private clampTarget() {
    // не даём «улететь» дальше загруженных деталей при резком скролле
    const lim = 45;
    if (this.sTarget - this.s > lim) this.sTarget = this.s + lim;
    if (this.sTarget - this.s < -lim) this.sTarget = this.s - lim;
  }

  /** Плавно доехать до позиции (берёт ближайший путь по кругу). */
  goTo(sAbs: number, L: number) {
    const d = sAbs - this.s;
    const w = d - L * Math.floor(d / L + 0.5);
    this.sTarget = this.s + w;
    this.interacted = true;
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.enabled) return;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= window.innerHeight;
    this.nudge(dy * this.wheelGain);
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    this.dragging = true;
    this.lastPointer = { x: e.clientX, y: e.clientY };
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    this.lookX = (e.clientX / window.innerWidth) * 2 - 1;
    this.lookY = (e.clientY / window.innerHeight) * 2 - 1;
    if (this.dragging && this.lastPointer) {
      const dx = e.clientX - this.lastPointer.x;
      const dy = e.clientY - this.lastPointer.y;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.dragYaw += dx * 0.0035;
      this.dragPitch -= dy * 0.0035;
      this.dragYaw = Math.max(-1.3, Math.min(1.3, this.dragYaw));
      this.dragPitch = Math.max(-0.5, Math.min(1.25, this.dragPitch));
    }
  };

  private onPointerUp = () => {
    this.dragging = false;
    this.lastPointer = null;
  };

  private onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    this.touch = { x: t.clientX, y: t.clientY, t: performance.now(), vx: 0, vy: 0, axis: 'none' };
    this.inertia = 0;
  };

  private onTouchMove = (e: TouchEvent) => {
    if (!this.touch || e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    const now = performance.now();
    const dt = Math.max(1, now - this.touch.t) / 1000;
    const dx = t.clientX - this.touch.x;
    const dy = t.clientY - this.touch.y;
    if (this.touch.axis === 'none' && Math.hypot(dx, dy) > 6) this.touch.axis = Math.abs(dy) >= Math.abs(dx) ? 'walk' : 'look';
    if (this.touch.axis === 'walk') {
      const m = -dy * 0.07;
      this.nudge(m);
      this.touch.vy = 0.7 * this.touch.vy + 0.3 * (m / dt);
    } else if (this.touch.axis === 'look') {
      this.dragYaw = Math.max(-1.3, Math.min(1.3, this.dragYaw - dx * 0.005));
    }
    this.touch.x = t.clientX;
    this.touch.y = t.clientY;
    this.touch.t = now;
  };

  private onTouchEnd = () => {
    if (this.touch?.axis === 'walk' && performance.now() - this.touch.t < 120) this.inertia = Math.max(-40, Math.min(40, this.touch.vy));
    this.touch = null;
  };

  update(dt: number) {
    // клавиши
    const kv = (this.keys.has('ArrowDown') ? 1 : 0) - (this.keys.has('ArrowUp') ? 1 : 0);
    this.keyVel += (kv * 9 - this.keyVel) * Math.min(1, dt * 4);
    if (Math.abs(this.keyVel) > 0.01 && this.enabled) {
      this.sTarget += this.keyVel * dt;
      this.interacted = true;
    }
    const ky = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);
    if (ky) this.dragYaw = Math.max(-1.3, Math.min(1.3, this.dragYaw + ky * dt * 0.9));

    // инерция тача
    if (Math.abs(this.inertia) > 0.05) {
      this.sTarget += this.inertia * dt;
      this.inertia *= Math.exp(-dt * 2.2);
    }

    const prev = this.s;
    const k = 1 - Math.exp(-dt * (reduceMotion ? 12 : this.smoothing));
    this.s += (this.sTarget - this.s) * k;
    const v = (this.s - prev) / Math.max(dt, 1e-3);
    this.velocity += (v - this.velocity) * Math.min(1, dt * 6);

    // взгляд: мышь даёт лёгкий параллакс, драг — свободный обзор, который мягко возвращается
    if (!this.dragging && !this.touch) {
      const back = Math.exp(-dt * 0.6);
      this.dragYaw *= back;
      this.dragPitch *= back;
    }
    const ml = this.mouseLook ? 1 : 0;
    const ty = this.lookX * 0.09 * ml + this.dragYaw;
    const tp = this.basePitch - this.lookY * 0.05 * ml + this.dragPitch;
    const kl = 1 - Math.exp(-dt * 3.5);
    this.yaw += (ty - this.yaw) * kl;
    this.pitch += (Math.max(-0.6, Math.min(1.35, tp)) - this.pitch) * kl;
  }
}
