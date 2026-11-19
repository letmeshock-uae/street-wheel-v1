// WebGL2-рендерер сплатов: страничный пул в текстурах + инстансинг по отсортированным индексам.
import { SPLAT_FS, SPLAT_VS } from './shaders';
import type { Manifest } from './data';

export const PAGE = 2048; // сплатов в странице = ширина текстуры пула (одна строка)

export interface FrameUniforms {
  view: Float32Array;
  proj: Float32Array;
  focal: [number, number];
  viewport: [number, number];
  ring: [number, number, number, number];
  ring2: [number, number, number, number];
  dens: [number, number, number, number];
  part: [number, number, number, number];
  seam: [number, number, number, number];
  seamP: [number, number, number, number];
  lat: [number, number, number, number];
  misc: [number, number, number, number];
  float: [number, number, number, number];
  motion: [number, number, number, number];
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader error');
  return sh;
}

export class SplatRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly rows: number;
  readonly capacity: number;
  private prog: WebGLProgram;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private texA: WebGLTexture;
  private texB: WebGLTexture;
  private segTex: WebGLTexture;
  private birthTex: WebGLTexture;
  /** текущее время (сек) — помечаем им заливаемые страницы, шейдер делает «прилёт» частиц */
  clock = 0;
  private vao: WebGLVertexArrayObject;
  private indexBuf: WebGLBuffer;
  private indexCap = 0;
  private free: number[] = [];
  count = 0;

  constructor(readonly canvas: HTMLCanvasElement, capacitySplats: number) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 недоступен');
    this.gl = gl;

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.rows = Math.max(16, Math.min(maxTex, Math.ceil(capacitySplats / PAGE)));
    this.capacity = this.rows * PAGE;
    for (let r = this.rows - 1; r >= 0; r--) this.free.push(r);

    const vs = compile(gl, gl.VERTEX_SHADER, SPLAT_VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, SPLAT_FS);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_index');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link error');
    this.prog = prog;
    for (const n of ['u_texA', 'u_texB', 'u_seg', 'u_view', 'u_proj', 'u_focal', 'u_viewport', 'u_ring', 'u_ring2', 'u_dens', 'u_part', 'u_seam', 'u_seamP', 'u_lat', 'u_misc', 'u_float', 'u_birth', 'u_motion'])
      this.loc[n] = gl.getUniformLocation(prog, n);

    const mkTex = (internal: number, w: number, h: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.texA = mkTex(gl.RGBA32UI, PAGE, this.rows);
    this.texB = mkTex(gl.R32UI, PAGE, this.rows);
    this.segTex = gl.createTexture()!;
    this.birthTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.birthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.rows, 1, 0, gl.RED, gl.FLOAT, new Float32Array(this.rows).fill(-1e4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.vao = gl.createVertexArray()!;
    this.indexBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
    this.ensureIndexCap(1 << 16);
  }

  get freePages(): number {
    return this.free.length;
  }

  allocPages(n: number): Int32Array | null {
    if (this.free.length < n) return null;
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.free.pop()!;
    return out;
  }

  releasePages(pages: Int32Array) {
    for (const p of pages) this.free.push(p);
  }

  uploadChunk(pages: Int32Array, texA: Uint32Array, texB: Uint32Array, count: number) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (let j = 0; j < pages.length; j++) {
      const n = Math.min(PAGE, count - j * PAGE);
      if (n <= 0) break;
      gl.bindTexture(gl.TEXTURE_2D, this.texA);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, pages[j], n, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, texA, j * PAGE * 4);
      gl.bindTexture(gl.TEXTURE_2D, this.texB);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, pages[j], n, 1, gl.RED_INTEGER, gl.UNSIGNED_INT, texB, j * PAGE);
    }
    const t = new Float32Array([this.clock]);
    gl.bindTexture(gl.TEXTURE_2D, this.birthTex);
    for (const row of pages) gl.texSubImage2D(gl.TEXTURE_2D, 0, row, 0, 1, 1, gl.RED, gl.FLOAT, t);
  }

  setSegments(m: Manifest) {
    const gl = this.gl;
    const n = m.segments.length + 1;
    const data = new Float32Array(n * 2 * 4);
    for (const s of m.segments) {
      data.set([s.bmin[0], s.bmin[1], s.bmin[2], 0, s.ext[0], s.ext[1], s.ext[2], 0], s.id * 8);
    }
    const sm = m.seam;
    data.set([sm.bmin[0], sm.bmin[1], sm.bmin[2], 1, sm.ext[0], sm.ext[1], sm.ext[2], 0], sm.id * 8);
    gl.bindTexture(gl.TEXTURE_2D, this.segTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n * 2, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  private ensureIndexCap(n: number) {
    if (n <= this.indexCap) return;
    const gl = this.gl;
    this.indexCap = Math.ceil(n * 1.3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.indexCap * 4, gl.DYNAMIC_DRAW);
  }

  setIndices(data: Uint32Array, count: number) {
    const gl = this.gl;
    this.ensureIndexCap(count);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count);
    this.count = count;
  }

  render(u: FrameUniforms, bg: [number, number, number]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, u.viewport[0], u.viewport[1]);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.count === 0) return;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.segTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.birthTex);
    const L = this.loc;
    gl.uniform1i(L.u_texA, 0);
    gl.uniform1i(L.u_texB, 1);
    gl.uniform1i(L.u_seg, 2);
    gl.uniform1i(L.u_birth, 3);
    gl.uniformMatrix4fv(L.u_view, false, u.view);
    gl.uniformMatrix4fv(L.u_proj, false, u.proj);
    gl.uniform2fv(L.u_focal, u.focal);
    gl.uniform2fv(L.u_viewport, u.viewport);
    gl.uniform4fv(L.u_ring, u.ring);
    gl.uniform4fv(L.u_ring2, u.ring2);
    gl.uniform4fv(L.u_dens, u.dens);
    gl.uniform4fv(L.u_part, u.part);
    gl.uniform4fv(L.u_seam, u.seam);
    gl.uniform4fv(L.u_seamP, u.seamP);
    gl.uniform4fv(L.u_lat, u.lat);
    gl.uniform4fv(L.u_misc, u.misc);
    gl.uniform4fv(L.u_float, u.float);
    gl.uniform4fv(L.u_motion, u.motion);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
  }
}
