// Воркер загрузки: fetch → gunzip → раскодирование в готовые для GPU массивы.
// Главный поток только заливает текстуры, поэтому скролл не дёргается во время стриминга.
import { decodeChunk, fetchGunzip, type DecodedChunk } from './data';

export interface DecodeJob {
  jobId: number;
  url: string;
  chunks: {
    seg: number;
    tier: number;
    offset: number;
    count: number;
    bmin: number[];
    ext: number[];
    rank0: number;
    rank1: number;
  }[];
}

export type DecodeReply =
  | { type: 'progress'; jobId: number; loaded: number }
  | { type: 'chunk'; jobId: number; chunk: DecodedChunk }
  | { type: 'done'; jobId: number; bytes: number }
  | { type: 'error'; jobId: number; message: string };

const post = (msg: DecodeReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<DecodeJob>) => {
  const job = e.data;
  try {
    let lastReport = 0;
    let bytes = 0;
    const raw = await fetchGunzip(job.url, (loaded) => {
      bytes = loaded;
      const now = performance.now();
      if (now - lastReport > 80) {
        lastReport = now;
        post({ type: 'progress', jobId: job.jobId, loaded });
      }
    });
    for (const c of job.chunks) {
      const d = decodeChunk(raw, c.offset, c.count, c.seg, c.tier, c.bmin, c.ext, c.rank0, c.rank1);
      post({ type: 'chunk', jobId: job.jobId, chunk: d }, [d.texA.buffer, d.texB.buffer, d.pos.buffer, d.rank.buffer, d.alpha.buffer]);
    }
    post({ type: 'done', jobId: job.jobId, bytes });
  } catch (err) {
    post({ type: 'error', jobId: job.jobId, message: String(err) });
  }
};
