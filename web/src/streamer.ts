// Стриминг LOD: tier0 всего кольца грузится сразу (редкие частицы), остальные тиры —
// только для сегментов рядом с пользователем (и с упреждением по направлению скролла).
// Дальние детали выгружаются, когда пулу GPU не хватает места.
import type { DecodedChunk, Manifest } from './data';
import type { DecodeJob, DecodeReply } from './decode.worker';
import { PAGE, type SplatRenderer } from './renderer';
import { densityAlong, wrap, type RevealParams, type Street } from './ring';
import type { SortIn } from './sort.worker';

interface ChunkState {
  key: string;
  seg: number;
  tier: number;
  state: 'loading' | 'ready';
  id: number;
  pages: Int32Array | null;
  count: number;
  bytes: number;
}

export interface StreamStats {
  loadedSplats: number;
  loadedChunks: number;
  inflight: number;
  bytes: number;
  poolUsed: number;
}

export class Streamer {
  private chunks = new Map<string, ChunkState>();
  private decoders: Worker[] = [];
  private nextDecoder = 0;
  private jobId = 1;
  private jobs = new Map<number, { onChunk: (c: DecodedChunk) => void; resolve: () => void; reject: (e: Error) => void; onProgress?: (n: number) => void }>();
  private uploads: { st: ChunkState | null; chunk: DecodedChunk; partOnly: boolean; s0: number; s1: number; rankMin: number }[] = [];
  private pendingFree: { pages: Int32Array; afterReq: number }[] = [];
  private nextChunkId = 1;
  private inflight = 0;
  bytes = 0;
  dirty = false; // появились/исчезли сплаты — нужна пересортировка
  readonly street: Street;

  constructor(
    private m: Manifest,
    private renderer: SplatRenderer,
    private sorter: Worker,
    private dataUrl: string,
    private maxRank: number,
    private getNextReqId: () => number,
  ) {
    this.street = { sMin: m.street.sMin, sMax: m.street.sMax, length: m.street.length };
    const n = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<DecodeReply>) => this.onDecode(e.data);
      this.decoders.push(w);
    }
  }

  private onDecode(r: DecodeReply) {
    const job = this.jobs.get(r.jobId);
    if (!job) return;
    if (r.type === 'progress') job.onProgress?.(r.loaded);
    else if (r.type === 'chunk') job.onChunk(r.chunk);
    else if (r.type === 'done') {
      this.bytes += r.bytes;
      this.jobs.delete(r.jobId);
      job.resolve();
    } else if (r.type === 'error') {
      this.jobs.delete(r.jobId);
      job.reject(new Error(r.message));
    }
  }

  private run(job: Omit<DecodeJob, 'jobId'>, onChunk: (c: DecodedChunk) => void, onProgress?: (n: number) => void): Promise<void> {
    const jobId = this.jobId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(jobId, { onChunk, resolve, reject, onProgress });
      const w = this.decoders[this.nextDecoder++ % this.decoders.length];
      w.postMessage({ ...job, jobId } satisfies DecodeJob);
    });
  }

  private segBounds(seg: number): { bmin: number[]; ext: number[]; s0: number; s1: number } {
    if (seg === this.m.seam.id) {
      const sm = this.m.seam;
      return { bmin: sm.bmin, ext: sm.ext, s0: sm.bmin[0], s1: sm.bmin[0] + sm.ext[0] };
    }
    const s = this.m.segments[seg];
    return { bmin: s.bmin, ext: s.ext, s0: s.s0, s1: s.s1 };
  }

  /** Стартовая загрузка: редкие частицы всего кольца + частицы шва. */
  async loadBase(onProgress: (frac: number) => void): Promise<void> {
    const tr = this.m.tierRanks;
    const chunks = this.m.base.chunks.map((c) => {
      const b = this.segBounds(c.seg);
      return { seg: c.seg, tier: c.tier, offset: c.offset, count: c.count, bmin: b.bmin, ext: b.ext, rank0: c.tier < 0 ? 0 : tr[0], rank1: c.tier < 0 ? 1 : tr[1] };
    });
    await this.run(
      { url: this.dataUrl + this.m.base.file, chunks },
      (chunk) => {
        const st: ChunkState = { key: `${chunk.seg}:${chunk.tier}`, seg: chunk.seg, tier: chunk.tier, state: 'loading', id: 0, pages: null, count: chunk.count, bytes: 0 };
        this.chunks.set(st.key, st);
        const b = this.segBounds(chunk.seg);
        this.uploads.push({ st, chunk, partOnly: chunk.tier < 0, s0: b.s0, s1: b.s1, rankMin: chunk.tier < 0 ? 0 : tr[0] });
      },
      (loaded) => onProgress(Math.min(1, loaded / this.m.base.bytes)),
    );
    this.processUploads(Infinity);
    void this.loadSeam();
  }

  /** Частицы шва: облако в форме профиля улицы, которое прячет стык концов. */
  private async loadSeam() {
    const sm = this.m.seam;
    const st: ChunkState = { key: `${sm.id}:-1`, seg: sm.id, tier: -1, state: 'loading', id: 0, pages: null, count: sm.count, bytes: sm.bytes };
    this.chunks.set(st.key, st);
    const b = this.segBounds(sm.id);
    await this.run(
      { url: this.dataUrl + sm.file, chunks: [{ seg: sm.id, tier: -1, offset: 0, count: sm.count, bmin: sm.bmin, ext: sm.ext, rank0: 0, rank1: 1 }] },
      (chunk) => this.uploads.push({ st, chunk, partOnly: true, s0: b.s0, s1: b.s1, rankMin: 0 }),
    ).catch((e) => console.warn('seam', e));
  }

  /** Сколько деталей нужно сегменту: максимум плотности по его длине (для текущей и будущей позиции). */
  private segDensity(seg: number, sCams: number[], reveal: RevealParams): number {
    const s = this.m.segments[seg];
    let mx = 0;
    for (const sc of sCams) {
      for (let k = 0; k <= 4; k++) {
        const x = s.s0 + ((s.s1 - s.s0) * k) / 4 - (k === 4 ? 1e-3 : 0);
        const d = densityAlong(x, sc, this.street, reveal).dens;
        if (d > mx) mx = d;
      }
    }
    return mx;
  }

  update(sCam: number, velocity: number, reveal: RevealParams) {
    const L = this.street.length;
    const ahead = sCam + Math.max(-30, Math.min(30, velocity * 1.6));
    const sCams = [sCam, ahead];
    const tr = this.m.tierRanks;
    const want: { seg: number; tier: number; score: number }[] = [];
    const segDens = this.m.segments.map((s) => this.segDensity(s.id, sCams, reveal));

    for (const s of this.m.segments) {
      const dens = segDens[s.id];
      const mid = (s.s0 + s.s1) / 2;
      const dSigned = wrap(mid - sCam, L);
      const dist = Math.min(Math.abs(dSigned), Math.abs(wrap(mid - ahead, L)));
      // то, что позади по ходу движения, грузим во вторую очередь
      const behind = dSigned * Math.sign(velocity || 1) < -8 ? 12 : 0;
      for (let t = 1; t < tr.length - 1; t++) {
        if (tr[t] >= this.maxRank || tr[t] >= dens) break;
        if (!s.tiers[t]?.file || s.tiers[t].count === 0) continue;
        const key = `${s.id}:${t}`;
        if (this.chunks.has(key)) continue;
        want.push({ seg: s.id, tier: t, score: dist + behind + tr[t] * 40 });
      }
    }
    want.sort((a, b) => a.score - b.score);

    const maxInflight = 4;
    for (const w of want) {
      if (this.inflight >= maxInflight) break;
      const seg = this.m.segments[w.seg];
      const info = seg.tiers[w.tier];
      const pagesNeeded = Math.ceil(info.count / PAGE);
      // страницы выгруженных кусков освобождаются после ближайшей сортировки — учитываем их как «скоро свободные»
      const soon = this.renderer.freePages + this.pendingPages() - this.reservedPages();
      if (soon < pagesNeeded) this.evict(pagesNeeded - soon, sCams, segDens, w.score);
      if (this.renderer.freePages - this.reservedPages() < pagesNeeded) break;
      this.startLoad(w.seg, w.tier);
    }
  }

  private pendingPages(): number {
    let n = 0;
    for (const p of this.pendingFree) n += p.pages.length;
    return n;
  }

  private reservedPages(): number {
    let n = 0;
    for (const c of this.chunks.values()) if (c.state === 'loading') n += Math.ceil(c.count / PAGE);
    return n;
  }

  /** Освобождает место: выгружает самые ненужные детальные тиры. */
  private evict(pagesNeeded: number, sCams: number[], segDens: number[], incomingScore: number) {
    const L = this.street.length;
    const tr = this.m.tierRanks;
    const cands: { st: ChunkState; score: number }[] = [];
    for (const st of this.chunks.values()) {
      if (st.state !== 'ready' || st.tier < 1) continue;
      const seg = this.m.segments[st.seg];
      const mid = (seg.s0 + seg.s1) / 2;
      const dist = Math.min(...sCams.map((s) => Math.abs(wrap(mid - s, L))));
      const score = dist + tr[st.tier] * 40;
      const unneeded = tr[st.tier] > segDens[st.seg] + 0.05;
      // выгружаем только то, что не нужно, или заметно менее важно, чем то, что грузим
      if (unneeded || score > incomingScore + 25) cands.push({ st, score: score + (unneeded ? 1000 : 0) });
    }
    cands.sort((a, b) => b.score - a.score);
    let freed = 0;
    for (const c of cands) {
      if (freed >= pagesNeeded) break;
      freed += c.st.pages ? c.st.pages.length : 0;
      this.unload(c.st);
    }
  }

  private unload(st: ChunkState) {
    this.chunks.delete(st.key);
    this.sorter.postMessage({ type: 'remove', id: st.id } satisfies SortIn);
    if (st.pages) this.pendingFree.push({ pages: st.pages, afterReq: this.getNextReqId() });
    st.pages = null;
    this.dirty = true;
  }

  private startLoad(seg: number, tier: number) {
    const s = this.m.segments[seg];
    const info = s.tiers[tier];
    const tr = this.m.tierRanks;
    const st: ChunkState = { key: `${seg}:${tier}`, seg, tier, state: 'loading', id: 0, pages: null, count: info.count, bytes: info.bytes ?? 0 };
    this.chunks.set(st.key, st);
    this.inflight++;
    this.run(
      {
        url: this.dataUrl + info.file,
        chunks: [{ seg, tier, offset: 0, count: info.count, bmin: s.bmin, ext: s.ext, rank0: tr[tier], rank1: tr[tier + 1] }],
      },
      (chunk) => {
        if (this.chunks.get(st.key) !== st) return; // успели передумать
        this.uploads.push({ st, chunk, partOnly: false, s0: s.s0, s1: s.s1, rankMin: tr[tier] });
      },
    )
      .catch((e) => {
        console.warn(e);
        this.chunks.delete(st.key);
      })
      .finally(() => this.inflight--);
  }

  /** Заливает раскодированные куски в GPU с ограничением на кадр. */
  processUploads(budgetSplats = 160_000) {
    let used = 0;
    while (this.uploads.length && used < budgetSplats) {
      const u = this.uploads.shift()!;
      const st = u.st;
      if (st && this.chunks.get(st.key) !== st) continue;
      const pages = this.renderer.allocPages(Math.ceil(u.chunk.count / PAGE));
      if (!pages) {
        // пул переполнен — откатываемся, попробуем позже
        if (st) this.chunks.delete(st.key);
        continue;
      }
      this.renderer.uploadChunk(pages, u.chunk.texA, u.chunk.texB, u.chunk.count);
      const id = this.nextChunkId++;
      if (st) {
        st.state = 'ready';
        st.id = id;
        st.pages = pages;
      }
      const msg: SortIn = {
        type: 'add',
        id,
        seg: u.chunk.seg,
        partOnly: u.partOnly,
        pos: u.chunk.pos,
        rank: u.chunk.rank,
        alpha: u.chunk.alpha,
        pages,
        rankMin: u.rankMin,
        s0: u.s0,
        s1: u.s1,
      };
      this.sorter.postMessage(msg, [u.chunk.pos.buffer, u.chunk.rank.buffer, u.chunk.alpha.buffer]);
      used += u.chunk.count;
      this.dirty = true;
    }
  }

  /** Вызывается, когда пришёл результат сортировки reqId: старые страницы больше не используются. */
  onSorted(reqId: number) {
    this.pendingFree = this.pendingFree.filter((p) => {
      if (reqId >= p.afterReq) {
        this.renderer.releasePages(p.pages);
        return false;
      }
      return true;
    });
  }

  stats(): StreamStats {
    let loadedSplats = 0, loadedChunks = 0;
    for (const c of this.chunks.values())
      if (c.state === 'ready') {
        loadedSplats += c.count;
        loadedChunks++;
      }
    return {
      loadedSplats,
      loadedChunks,
      inflight: this.inflight,
      bytes: this.bytes,
      poolUsed: 1 - this.renderer.freePages / this.renderer.rows,
    };
  }
}
