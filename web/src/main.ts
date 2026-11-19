import './style.css';
import { Camera } from './camera';
import type { Manifest } from './data';
import { Controls } from './controls';
import { DebugHud, WheelHud } from './hud';
import { Adaptive, detectQuality, PROFILES } from './quality';
import { SplatRenderer, type FrameUniforms } from './renderer';
import { DEFAULT_REVEAL, smoothstep, wrap, type RevealParams } from './ring';
import { Streamer } from './streamer';
import type { SortIn, SortOut, SortRequest } from './sort.worker';
import { loadSettings, TunePanel } from './tune';

const params = new URLSearchParams(location.search);
// ?data=имя_папки — A/B-сравнение разных сборок данных из public/
// абсолютный URL: воркеры резолвят относительные пути от своего файла (/assets/), а не от страницы
const DATA = new URL(import.meta.env.BASE_URL + (params.get('data')?.replace(/[^\w-]/g, '') || 'data') + '/', location.href).href;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- шов: короткий. Концы улицы растворяются на последних SEAM.outer м, а частицы шва
// заполняют ±SEAM.width м вокруг стыка. ?seam=14 — подобрать ширину на лету (м).
const seamParam = Number(params.get('seam'));
const SEAM_W = Number.isFinite(seamParam) && seamParam > 0 ? seamParam : 10;
const SEAM = { inner: 1, outer: SEAM_W * 0.8, width: SEAM_W };

// ---- настройки сцены. Живые — в панели (?tune — кнопка в правом верхнем углу), см. tune.ts;
// через URL: ?eye=3&pitch=0.4&fov=78&exp=1.2, а также ?lane=-8&s=55
const S = loadSettings(params);
const LOOK = {
  lane: Number(params.get('lane') ?? -8),
  startS: Number(params.get('s') ?? 0),
  bg: [0.0, 0.0, 0.0] as [number, number, number],
};

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

async function main() {
  const canvas = $('#gl') as HTMLCanvasElement;
  const ui = $('#ui');
  const loader = $('#loader');
  const bar = $('#loader-bar');
  const status = $('#loader-status');

  const manifest: Manifest = await (await fetch(DATA + 'manifest.json')).json();
  const street = { sMin: manifest.street.sMin, sMax: manifest.street.sMax, length: manifest.street.length };
  const L = street.length;
  const kFull = (2 * Math.PI) / L;

  const q = detectQuality();
  const profile = PROFILES[q.name];
  let renderer: SplatRenderer;
  try {
    renderer = new SplatRenderer(canvas, profile.poolSplats);
  } catch (e) {
    status.textContent = 'Ваш браузер не поддерживает WebGL2 — сцена недоступна.';
    throw e;
  }
  renderer.setSegments(manifest);

  // ---- воркер сортировки
  const sorter = new Worker(new URL('./sort.worker.ts', import.meta.url), { type: 'module' });
  sorter.postMessage({ type: 'init', street } satisfies SortIn);
  let reqId = 1;
  let sortBusy = false;
  let lastSortMs: number | null = null;
  let sortStats = { candidates: 0, kept: 0, ms: 0 };
  const picks = new Map<number, (hit: { s: number; h: number; w: number } | null) => void>();

  const streamer = new Streamer(manifest, renderer, sorter, DATA, profile.maxRank, () => reqId);

  sorter.onmessage = (e: MessageEvent<SortOut>) => {
    const m = e.data;
    if (m.type === 'sorted') {
      renderer.setIndices(new Uint32Array(m.buf), m.count);
      sorter.postMessage({ type: 'recycle', buf: m.buf } satisfies SortIn, [m.buf]);
      streamer.onSorted(m.reqId);
      lastSortMs = m.ms;
      sortStats = { candidates: m.candidates, kept: m.kept, ms: m.ms };
      sortBusy = false;
    } else if (m.type === 'picked') {
      picks.get(m.reqId)?.(m.hit);
      picks.delete(m.reqId);
    }
  };

  // ---- стартовая загрузка (редкие частицы всего кольца)
  await streamer.loadBase((f) => (bar.style.transform = `scaleX(${(0.1 + f * 0.9).toFixed(3)})`));

  const cam = new Camera();
  cam.eye = [0, S.eye, LOOK.lane];
  cam.fovY = (S.fov * Math.PI) / 180;
  const controls = new Controls(canvas);
  controls.basePitch = S.pitch;
  controls.s = controls.sTarget = LOOK.startS;
  controls.mouseLook = true;
  const adaptive = new Adaptive();

  // ---- миникарта-колесо (без подписей)
  const hud = new WheelHud(ui, L, street.sMax, SEAM.width);

  // любая правка в панели → пересортировка с новыми параметрами
  let tuneVersion = 0;
  if (params.has('tune')) new TunePanel(ui, S, () => tuneVersion++);

  const debug = new DebugHud(ui);
  if (!params.has('debug')) debug.toggle();

  window.addEventListener('keydown', (e) => {
    if (e.key === 'd' && e.shiftKey) debug.toggle();
  });

  // ---- интро: прямая улица сворачивается в колесо
  let introT = reduceMotion || params.has('nointro') ? 1 : 0;
  let kappa = introT >= 1 ? kFull : 0;
  let globalAlpha = introT >= 1 ? 1 : 0;
  const INTRO_DELAY = 0.6, INTRO_DUR = 5.5;
  let clock = 0;
  let animClock = 0; // время анимации парения (скорость регулируется, при reduced motion стоит)

  const sCamOf = (s: number) => street.sMin + (((s - street.sMin) % L) + L) % L;

  const currentReveal = (): RevealParams => {
    const k = profile.radius * adaptive.detail;
    return {
      ...DEFAULT_REVEAL,
      densNear: S.densNear * k,
      densPow: S.densPow,
      farDensity: S.farDensity,
      partNear: S.partNear * k,
      partFar: Math.max(S.partNear * k + 1, S.partFar * Math.max(0.75, k)),
      seamInner: SEAM.inner,
      seamOuter: SEAM.outer,
      seamWidth: SEAM.width,
    };
  };

  // ---- размеры
  let cssW = 0, cssH = 0, dpr = 1;
  const resize = () => {
    cssW = innerWidth;
    cssH = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, profile.dprMax) * adaptive.renderScale;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
  };
  resize();
  window.addEventListener('resize', resize);
  let lastScale = adaptive.renderScale;

  // ---- сортировка: держим один запрос «в полёте», шлём только если что-то поменялось
  let lastSortKey = '';
  const requestSort = (sCam: number, reveal: RevealParams, force: boolean) => {
    if (sortBusy) return;
    const key = [sCam.toFixed(3), kappa.toFixed(6), cam.yaw.toFixed(3), cam.pitch.toFixed(3), reveal.densNear.toFixed(2), cam.aspect.toFixed(3), cam.eye[1], tuneVersion].join('|');
    if (!force && key === lastSortKey) return;
    lastSortKey = key;
    streamer.dirty = false;
    sortBusy = true;
    const req: SortRequest = {
      type: 'sort',
      reqId: reqId++,
      sCam,
      kappa,
      eye: [...cam.eye],
      fwd: cam.fwd,
      right: cam.right,
      up: cam.up,
      // запас по фрустуму: камера успевает повернуться, пока идёт сортировка
      tanX: cam.tanX * 1.18,
      tanY: cam.tanY * 1.18,
      // парящие точки сдвинуты шейдером с настоящих мест — расширяем отсечение на величину сдвига
      pad: [2 + S.scatterBase + (reduceMotion ? 0 : S.driftFar + S.driftNear), S.scatterPerM],
      reveal,
      maxSorted: profile.maxSorted,
    };
    sorter.postMessage(req);
  };

  loader.classList.add('done');
  setTimeout(() => loader.remove(), 1200);

  let last = performance.now();
  let streamTimer = 0;
  const uni: FrameUniforms = {
    view: cam.view,
    proj: cam.proj,
    focal: [1, 1],
    viewport: [1, 1],
    ring: [0, 0, L, street.sMin],
    ring2: [street.sMax, SEAM.width, 0, 1],
    dens: [0, 0, 0, 0],
    part: [0, 0, 0, 0],
    seam: [0, 0, 0, 0],
    seamP: [0, 0, 0, 0],
    lat: [0, 0, 0, 0],
    misc: [manifest.quant.scaleLogMin, (manifest.quant.scaleLogMax - manifest.quant.scaleLogMin) / 255, 0.012, 0],
    // «лимбо»: базовый разлёт несобранной частицы (м), + м на метр расстояния, парение рядом / вдали (м)
    float: [0, 0, 0, 0],
    motion: [1, 0.25, 0, 0],
  };

  const frame = (now: number) => {
    const rawDt = now - last;
    const dtMs = Math.min(100, rawDt);
    last = now;
    const dt = dtMs / 1000;
    clock += dt;
    animClock += dt * (reduceMotion ? 0 : S.speed);

    // интро
    if (introT < 1) {
      introT = Math.min(1, Math.max(0, (clock - INTRO_DELAY) / INTRO_DUR));
      const e = introT < 0.5 ? 4 * introT ** 3 : 1 - (-2 * introT + 2) ** 3 / 2;
      kappa = kFull * e;
      globalAlpha = smoothstep(0, 1.6, clock);
      controls.basePitch = S.pitch * (0.15 + 0.85 * e);
    } else {
      kappa = kFull;
      globalAlpha = 1;
      controls.basePitch = S.pitch;
    }
    controls.wheelGain = S.wheelGain;
    controls.smoothing = S.smoothing;
    cam.eye[1] = S.eye;
    cam.fovY = (S.fov * Math.PI) / 180;

    controls.update(dt);
    const sCam = sCamOf(controls.s);
    cam.yaw = controls.yaw;
    cam.pitch = controls.pitch;

    adaptive.frame(rawDt, lastSortMs);
    lastSortMs = null;
    if (Math.abs(adaptive.renderScale - lastScale) > 1e-3) {
      lastScale = adaptive.renderScale;
      resize();
    }
    cam.update(canvas.width, canvas.height);
    const reveal = currentReveal();

    streamTimer += dt;
    if (streamTimer > 0.15) {
      streamTimer = 0;
      streamer.update(sCam, controls.velocity, reveal);
    }
    streamer.processUploads();
    requestSort(sCam, reveal, streamer.dirty);

    // uniforms
    const fy = canvas.height / 2 / cam.tanY;
    uni.focal = [fy, fy];
    uni.viewport = [canvas.width, canvas.height];
    uni.ring = [sCam, kappa, L, street.sMin];
    uni.ring2 = [street.sMax, SEAM.width, animClock, globalAlpha];
    uni.misc[3] = clock;
    renderer.clock = clock;
    uni.dens = [reveal.densNear, reveal.densFar, reveal.farDensity, reveal.densPow];
    uni.part = [reveal.partNear, reveal.partFar, S.dotPx * dpr, S.partAlpha];
    uni.seam = [reveal.seamInner, reveal.seamOuter, reveal.seamDensity, reduceMotion ? 0 : S.twinkle];
    uni.seamP = [reveal.seamPDensNear, reveal.seamPDensFar, S.exposure, canvas.height * 0.45];
    // «лимбо»: разлёт несобранной частицы (м + м на метр дали), парение рядом / вдали (м)
    uni.float = [S.scatterBase, S.scatterPerM, reduceMotion ? 0 : S.driftNear, reduceMotion ? 0 : S.driftFar];
    uni.motion = [1.45 / Math.max(0.05, S.arrive), S.emBand, 0, 0];
    uni.lat = [reveal.latCenter, reveal.latInner, reveal.latOuter, reveal.latDensity];
    renderer.render(uni, LOOK.bg);

    hud.update(sCam);

    if (debug.visible) {
      const st = streamer.stats();
      debug.set({
        quality: `${profile.name} (${q.gpu.slice(0, 28)})`,
        fps: adaptive.fps.toFixed(0),
        splats: `${(renderer.count / 1e6).toFixed(2)}M drawn / ${(sortStats.kept / 1e6).toFixed(2)}M kept / ${(sortStats.candidates / 1e6).toFixed(2)}M tested`,
        loaded: `${(st.loadedSplats / 1e6).toFixed(2)}M in ${st.loadedChunks} chunks, ${st.inflight} loading`,
        pool: `${(st.poolUsed * 100).toFixed(0)}% of ${(renderer.capacity / 1e6).toFixed(1)}M`,
        network: `${(st.bytes / 1e6).toFixed(1)} MB`,
        sort: `${sortStats.ms.toFixed(0)} ms`,
        scale: `${adaptive.renderScale.toFixed(2)} res, ${adaptive.detail.toFixed(2)} detail, dpr ${dpr.toFixed(2)}`,
        s: `${sCam.toFixed(1)} (d to seam ${Math.abs(wrap(sCam - street.sMax, L)).toFixed(0)} m)`,
      });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (params.has('debug')) {
    // ручной замер GPU-времени кадра: __wheel.bench()
    const gl = renderer.gl;
    Object.assign(window, {
      __wheel: {
        renderer,
        controls,
        cam,
        pick(x: number, y: number) {
          const r = cam.ray(x, y, innerWidth, innerHeight);
          const id = reqId++;
          return new Promise((res) => {
            picks.set(id, (hit) => res({ hit, ray: r, sCam: sCamOf(controls.s), kappa }));
            sorter.postMessage({ type: 'pick', reqId: id, sCam: sCamOf(controls.s), kappa, origin: r.origin, dir: r.dir, reveal: currentReveal() } satisfies SortIn);
          });
        },
        bench(n = 20) {
          const px = new Uint8Array(4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const t0 = performance.now();
          for (let i = 0; i < n; i++) renderer.render(uni, LOOK.bg);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          return { msPerFrame: (performance.now() - t0) / n, splats: renderer.count, px: [canvas.width, canvas.height] };
        },
      },
    });
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    status.textContent = 'Видеокарта сбросила контекст — перезагружаем…';
    setTimeout(() => location.reload(), 800);
  });
}

main().catch((e) => {
  console.error(e);
  const s = document.querySelector('#loader-status');
  if (s && !s.textContent?.includes('WebGL')) s.textContent = 'Не удалось загрузить сцену: ' + (e?.message ?? e);
});
