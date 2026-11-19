// Камера стоит на «дне» колеса; двигается мир (через sCam), камера только оглядывается.

export type V3 = [number, number, number];

export class Camera {
  eye: V3 = [0, 3.5, 0];
  yaw = 0; // + вправо
  pitch = 0.12; // + вверх
  fovY = (62 * Math.PI) / 180;
  near = 0.1;
  far = 2000;
  aspect = 1;

  readonly view = new Float32Array(16);
  readonly proj = new Float32Array(16);
  readonly viewProj = new Float32Array(16);
  fwd: V3 = [1, 0, 0];
  right: V3 = [0, 0, 1];
  up: V3 = [0, 1, 0];

  update(width: number, height: number) {
    this.aspect = width / height;
    // на портретных экранах расширяем вертикальный угол, чтобы не было «замочной скважины»
    const fov = this.aspect < 1 ? Math.min((84 * Math.PI) / 180, this.fovY / Math.max(this.aspect, 0.62) ** 0.6) : this.fovY;
    this.fovYEff = fov;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const f: V3 = [cp * cy, sp, cp * sy];
    // right = f × worldUp(0,1,0)
    let r: V3 = [-f[2], 0, f[0]];
    const rl = Math.hypot(r[0], r[2]) || 1;
    r = [r[0] / rl, 0, r[2] / rl];
    // up = right × f
    const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    this.fwd = f;
    this.right = r;
    this.up = u;
    const e = this.eye;
    const v = this.view;
    v[0] = r[0]; v[1] = u[0]; v[2] = -f[0]; v[3] = 0;
    v[4] = r[1]; v[5] = u[1]; v[6] = -f[1]; v[7] = 0;
    v[8] = r[2]; v[9] = u[2]; v[10] = -f[2]; v[11] = 0;
    v[12] = -(r[0] * e[0] + r[1] * e[1] + r[2] * e[2]);
    v[13] = -(u[0] * e[0] + u[1] * e[1] + u[2] * e[2]);
    v[14] = f[0] * e[0] + f[1] * e[1] + f[2] * e[2];
    v[15] = 1;

    const t = 1 / Math.tan(fov / 2);
    const p = this.proj;
    p.fill(0);
    p[0] = t / this.aspect;
    p[5] = t;
    p[10] = (this.far + this.near) / (this.near - this.far);
    p[11] = -1;
    p[14] = (2 * this.far * this.near) / (this.near - this.far);
    mul4(this.viewProj, p, v);
  }

  fovYEff = this.fovY;

  get tanY() {
    return Math.tan(this.fovYEff / 2);
  }
  get tanX() {
    return this.tanY * this.aspect;
  }

  /** Мировая точка → CSS-пиксели. null — за камерой. */
  project(x: number, y: number, z: number, cssW: number, cssH: number): { x: number; y: number; depth: number } | null {
    const m = this.viewProj;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw < 0.1) return null;
    return { x: (cx / cw * 0.5 + 0.5) * cssW, y: (1 - (cy / cw * 0.5 + 0.5)) * cssH, depth: cw };
  }

  /** Луч из CSS-пикселя (для пикинга). */
  ray(px: number, py: number, cssW: number, cssH: number): { origin: V3; dir: V3 } {
    const nx = (px / cssW) * 2 - 1;
    const ny = 1 - (py / cssH) * 2;
    const dx = this.fwd[0] + this.right[0] * nx * this.tanX + this.up[0] * ny * this.tanY;
    const dy = this.fwd[1] + this.right[1] * nx * this.tanX + this.up[1] * ny * this.tanY;
    const dz = this.fwd[2] + this.right[2] * nx * this.tanX + this.up[2] * ny * this.tanY;
    const l = Math.hypot(dx, dy, dz);
    return { origin: [...this.eye] as V3, dir: [dx / l, dy / l, dz / l] };
  }
}

function mul4(out: Float32Array, a: Float32Array, b: Float32Array) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
  }
}
