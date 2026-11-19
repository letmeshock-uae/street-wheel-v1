#!/usr/bin/env python3
"""
build_ring.py — готовит длинную 3DGS-улицу для веб-вьюера «улица-колесо».

Шаги:
  1) SOG -> PLY без SH (делает splat-transform, см. README):
       npx @playcanvas/splat-transform scene.sog -H 0 scene_sh0.ply
     (опционально: -B бокс-кроп и -F фильтр флоатеров)
  2) python3 tools/build_ring.py scene_sh0.ply web/public/data

Что делает скрипт:
  * переводит модель в «уличные» координаты (s — вдоль улицы, h — вверх, w — поперёк),
    выравнивает ось улицы и выравнивает землю в h=0 (иначе шов кольца не сойдётся по высоте);
  * режет по коридору улицы, выбрасывает почти прозрачные и гигантские сплаты;
  * режет улицу на сегменты по s, внутри сегмента упорядочивает сплаты по
    «важности со случайностью» (prefix любого размера = равномерная разрежённая версия);
  * делит порядок на тиры (LOD): tier0 — редкие частицы для всего кольца,
    дальше — всё больше деталей, грузятся только рядом с пользователем;
  * генерирует частицы шва: профиль улицы с обоих концов, «вытянутый» через шов;
  * квантует (≈18 байт/сплат до gzip) и пишет gzip-файлы + manifest.json.
"""
import argparse, gzip, json, math, os, sys, time
import numpy as np

C0 = 0.28209479177387814


def log(*a):
    print(*a, flush=True)


# ----------------------------------------------------------------------------- PLY
def read_ply(path):
    with open(path, 'rb') as f:
        hdr = b''
        while not hdr.endswith(b'end_header\n'):
            ch = f.read(1)
            if not ch:
                raise ValueError('bad PLY header')
            hdr += ch
    lines = hdr.split(b'\n')
    if not any(l.startswith(b'format binary_little_endian') for l in lines):
        raise ValueError('only binary_little_endian PLY supported')
    n = int([l for l in lines if l.startswith(b'element vertex')][0].split()[-1])
    props = [l.split() for l in lines if l.startswith(b'property')]
    if any(p[1] != b'float' for p in props):
        raise ValueError('expected float properties only (use splat-transform -H 0 output)')
    names = [p[-1].decode() for p in props]
    arr = np.memmap(path, dtype=np.float32, mode='r', offset=len(hdr), shape=(n, len(names)))
    return arr, {k: i for i, k in enumerate(names)}


# ----------------------------------------------------------------------------- math helpers
def quat_from_matrix(m):
    """3x3 rotation -> quaternion (w,x,y,z)."""
    t = np.trace(m)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        return np.array([0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s])
    i = int(np.argmax(np.diag(m)))
    if i == 0:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        return np.array([(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s])
    if i == 1:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        return np.array([(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s])
    s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
    return np.array([(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s])


def quat_mul(a, b):
    """a (4,) ⊗ b (N,4), order (w,x,y,z)."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    return np.stack([
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ], 1)


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def part1by2(x):
    x = x.astype(np.uint32) & 0x3FF
    x = (x | (x << 16)) & 0x030000FF
    x = (x | (x << 8)) & 0x0300F00F
    x = (x | (x << 4)) & 0x030C30C3
    x = (x | (x << 2)) & 0x09249249
    return x


def morton3(q):
    return part1by2(q[:, 0]) | (part1by2(q[:, 1]) << 1) | (part1by2(q[:, 2]) << 2)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('ply')
    ap.add_argument('out')
    ap.add_argument('--no-flip', action='store_true', help='модель уже y-up (по умолчанию поворачиваем на 180° вокруг X: эта модель y-down)')
    ap.add_argument('--s-range', type=float, nargs=2, default=[-160, 145], help='участок улицы вдоль X, который станет кольцом')
    ap.add_argument('--w-range', type=float, nargs=2, default=[-75, 65], help='поперечный кроп')
    ap.add_argument('--h-range', type=float, nargs=2, default=[-2.5, 44], help='кроп по высоте над землёй')
    ap.add_argument('--corridor', type=float, nargs=2, default=[-30, 15], help='поперечный диапазон проезжей части (для оценки земли)')
    ap.add_argument('--min-opacity', type=float, default=0.02)
    ap.add_argument('--max-scale', type=float, default=6.0, help='сплаты крупнее (м) выбрасываем')
    ap.add_argument('--seg-len', type=float, default=6.0)
    ap.add_argument('--tiers', type=str, default='0.03,0.08,0.18,0.4,0.7', help='границы рангов тиров (доли)')
    ap.add_argument('--seam-width', type=float, default=34.0, help='полуширина зоны шва (м) — где реальные сплаты растворяются')
    ap.add_argument('--seam-particles', type=int, default=280000)
    ap.add_argument('--seed', type=int, default=7)
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    t0 = time.time()
    os.makedirs(args.out, exist_ok=True)

    arr, col = read_ply(args.ply)
    n_all = arr.shape[0]
    log(f'loaded {n_all:,} splats, columns: {list(col)}')

    xyz = np.asarray(arr[:, [col['x'], col['y'], col['z']]], dtype=np.float64)
    if 'opacity' in col:
        op = 1.0 / (1.0 + np.exp(-np.asarray(arr[:, col['opacity']], dtype=np.float32)))
    else:
        op = np.clip(np.asarray(arr[:, col['opacity_linear']], dtype=np.float32), 0, 1)

    # ---- 1. базовый поворот (y-down -> y-up)
    R0 = np.eye(3) if args.no_flip else rot_x(math.pi)
    p = xyz @ R0.T  # (s, h, w)

    # ---- 2. выравнивание оси улицы (yaw вокруг h) по PCA плотного ядра
    core = (op > 0.2) & (np.abs(p[:, 0]) < 400)
    lo = np.percentile(p[core], 3, axis=0)
    hi = np.percentile(p[core], 97, axis=0)
    core &= np.all((p > lo) & (p < hi), axis=1)
    sub = p[core][::20]
    sw = sub[:, [0, 2]] - sub[:, [0, 2]].mean(0)
    _, _, vt = np.linalg.svd(sw, full_matrices=False)
    ax = vt[0] if vt[0][0] > 0 else -vt[0]
    yaw = math.atan2(ax[1], ax[0])  # угол оси улицы в плоскости (s,w)
    R1 = rot_y(yaw)  # поворот вокруг h, переводящий ось в +s  (rot_y(+a) поворачивает (1,0,tan a)->(…,0,…))
    p = p @ R1.T
    log(f'street yaw correction: {math.degrees(yaw):.3f}°')

    # ---- 3. земля: нижний перцентиль высоты в коридоре по бинам вдоль s
    #      (мода не годится: навесы/кроны/машины дают ложные пики)
    s_lo, s_hi = args.s_range
    def ground_profile(pp):
        bins = np.arange(s_lo - 10, s_hi + 10.001, 10.0)
        gx, gy = [], []
        m = (pp[:, 2] > args.corridor[0]) & (pp[:, 2] < args.corridor[1]) & (op > 0.3) & (pp[:, 1] > -6) & (pp[:, 1] < 10)
        ps, ph = pp[m, 0], pp[m, 1]
        for a, b in zip(bins[:-1], bins[1:]):
            mm = (ps >= a) & (ps < b)
            if mm.sum() < 300:
                continue
            gx.append((a + b) / 2)
            gy.append(np.percentile(ph[mm], 5))
        return np.array(gx), np.array(gy)

    def robust_poly(x, y, deg):
        keep_ = np.ones(len(x), bool)
        for _ in range(3):
            c = np.polyfit(x[keep_], y[keep_], deg)
            r = np.abs(np.polyval(c, x) - y)
            keep_ = r < max(0.35, np.percentile(r, 70))
        return c

    gx, gy = ground_profile(p)
    slope, icpt = robust_poly(gx, gy, 1)
    pitch = math.atan(slope)
    R2 = rot_z(-pitch)  # убираем общий наклон (поворот вокруг w)
    p = p @ R2.T
    gx, gy = ground_profile(p)
    dense = (gx > s_lo + args.seam_width * 0.6) & (gx < s_hi - args.seam_width * 0.6)
    cg = robust_poly(gx[dense], gy[dense], 2)
    # за пределами плотной части профиль не экстраполируем (np.interp держит крайние значения)
    gxs = np.linspace(s_lo + args.seam_width * 0.6, s_hi - args.seam_width * 0.6, 48)
    gys = np.clip(np.polyval(cg, gxs), -1.5, 1.5)
    log(f'ground slope corrected: {math.degrees(pitch):.3f}°, residual ground {gys.min():.2f}..{gys.max():.2f} m '
        f'(ends: {gys[0]:.2f} / {gys[-1]:.2f})')
    p[:, 1] -= np.interp(p[:, 0], gxs, gys)
    gx = gxs

    R = R2 @ R1 @ R0
    qR = quat_from_matrix(R)

    # ---- 4. кроп и чистка
    sc_log = np.asarray(arr[:, [col['scale_0'], col['scale_1'], col['scale_2']]], dtype=np.float32)
    max_sc = np.exp(sc_log.max(1))
    keep = (
        (p[:, 0] >= s_lo) & (p[:, 0] < s_hi)
        & (p[:, 2] >= args.w_range[0]) & (p[:, 2] < args.w_range[1])
        & (p[:, 1] >= args.h_range[0]) & (p[:, 1] < args.h_range[1])
        & (op >= args.min_opacity) & (max_sc <= args.max_scale)
        & np.all(np.isfinite(sc_log), 1)
    )
    idx = np.nonzero(keep)[0]
    n = len(idx)
    log(f'kept {n:,} / {n_all:,} splats ({n / n_all:.1%})')

    p = p[idx].astype(np.float64)
    op = op[idx]
    sc_log = sc_log[idx]
    q = np.asarray(arr[idx][:, [col['rot_0'], col['rot_1'], col['rot_2'], col['rot_3']]], dtype=np.float64)
    q /= np.linalg.norm(q, axis=1, keepdims=True) + 1e-12
    q = quat_mul(qR, q)
    q *= np.where(q[:, :1] < 0, -1, 1)
    dc = np.asarray(arr[idx][:, [col['f_dc_0'], col['f_dc_1'], col['f_dc_2']]], dtype=np.float32)
    rgb = np.clip(0.5 + C0 * dc, 0, 1)

    # ---- 5. квантование атрибутов (глобальные диапазоны)
    LOG_MIN, LOG_MAX = math.log(2e-4), math.log(args.max_scale)
    sc_q = np.clip(np.round((np.clip(sc_log, LOG_MIN, LOG_MAX) - LOG_MIN) / (LOG_MAX - LOG_MIN) * 255), 0, 255).astype(np.uint8)
    q_q = np.clip(np.round((q + 1) * 127.5), 0, 255).astype(np.uint8)
    rgba_q = np.empty((n, 4), np.uint8)
    rgba_q[:, :3] = np.round(rgb * 255)
    rgba_q[:, 3] = np.round(np.clip(op, 0, 1) * 255)

    # ---- 6. важность (для разрежения): непрозрачность × размер × яркость (ночью огни важнее)
    size = np.exp(sc_log.astype(np.float64).mean(1))
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    imp = op * np.clip(size, 0.004, 0.6) * (0.35 + lum) ** 1.5
    imp = np.maximum(imp, 1e-9) ** 0.75
    key = np.log(rng.random(n) + 1e-12) / imp  # взвешенная выборка без возвращения: больше = раньше

    tiers = [0.0] + [float(v) for v in args.tiers.split(',')] + [1.0]
    L = s_hi - s_lo
    nseg = int(math.ceil(L / args.seg_len))
    seg_len = L / nseg
    seg_of = np.minimum((p[:, 0] - s_lo) / seg_len, nseg - 1).astype(np.int32)

    manifest = {
        'version': 1,
        'generator': 'build_ring.py',
        'count': int(n),
        'street': {
            'sMin': s_lo, 'sMax': s_hi, 'length': L,
            'wMin': args.w_range[0], 'wMax': args.w_range[1],
            'hMax': args.h_range[1], 'corridor': args.corridor,
            'seamWidth': args.seam_width,
        },
        # model (исходные координаты модели) -> street: p' = R·p, затем h -= ground(s)
        'modelToStreet': {
            'matrix': R.tolist(),
            'groundS': gx.round(3).tolist(), 'groundH': gys.round(4).tolist(),
        },
        'quant': {'scaleLogMin': LOG_MIN, 'scaleLogMax': LOG_MAX},
        'tierRanks': tiers,
        'segments': [],
        'base': {'file': 'base.bin', 'chunks': []},
    }

    base_parts = []
    base_off = 0
    total_bytes = 0
    tier_counts = np.zeros(len(tiers) - 1, np.int64)

    def encode_chunk(sel_idx, ranks01, bmin, ext):
        """sel_idx: индексы сплатов; ranks01: ранг внутри тира [0,1). Возвращает байты (без gzip)."""
        m = len(sel_idx)
        pq = np.clip(np.round((p[sel_idx] - bmin) / ext * 65535), 0, 65535).astype(np.uint16)
        order = np.argsort(morton3(pq >> 6), kind='stable')
        pq = pq[order]
        si = sel_idx[order]
        rk = np.clip(np.floor(ranks01[order] * 256), 0, 255).astype(np.uint8)
        # дельта-кодирование позиций в мортон-порядке (хорошо жмётся)
        dpos = pq.copy()
        dpos[1:] = (pq[1:].astype(np.int32) - pq[:-1].astype(np.int32)).astype(np.uint16)
        parts = [
            np.ascontiguousarray(dpos.T).tobytes(),            # 3 * u16 planes
            rk.tobytes(),                                      # u8
            np.ascontiguousarray(rgba_q[si].T).tobytes(),      # 4 * u8 planes
            np.ascontiguousarray(sc_q[si].T).tobytes(),        # 3 * u8 planes
            np.ascontiguousarray(q_q[si].T).tobytes(),         # 4 * u8 planes
        ]
        b = b''.join(parts)
        assert len(b) == m * 18
        return b

    log(f'{nseg} segments of {seg_len:.2f} m; ring circumference {L:.1f} m -> radius {L / (2 * math.pi):.2f} m')
    order_all = np.argsort(seg_of, kind='stable')
    starts = np.searchsorted(seg_of[order_all], np.arange(nseg + 1))
    for sg in range(nseg):
        ii = order_all[starts[sg]:starts[sg + 1]]
        m = len(ii)
        pp = p[ii]
        bmin = pp.min(0) - 1e-3
        bmax = pp.max(0) + 1e-3
        ext = bmax - bmin
        ordr = ii[np.argsort(-key[ii], kind='stable')]
        rank = (np.arange(m) + 0.5) / max(m, 1)
        seg = {
            'id': sg, 's0': s_lo + sg * seg_len, 's1': s_lo + (sg + 1) * seg_len,
            'bmin': bmin.round(4).tolist(), 'ext': ext.round(4).tolist(), 'count': int(m), 'tiers': [],
        }
        for t in range(len(tiers) - 1):
            a, b = tiers[t], tiers[t + 1]
            sel = (rank >= a) & (rank < b)
            sidx = ordr[sel]
            r01 = (rank[sel] - a) / (b - a)
            raw = encode_chunk(sidx, r01, bmin, ext)
            tier_counts[t] += len(sidx)
            if t == 0:
                manifest['base']['chunks'].append({'seg': sg, 'tier': 0, 'offset': base_off, 'count': int(len(sidx))})
                base_parts.append(raw)
                base_off += len(raw)
                seg['tiers'].append({'count': int(len(sidx)), 'file': None})
            else:
                fn = f'seg{sg:03d}_t{t}.bin'
                gz = gzip.compress(raw, compresslevel=9, mtime=0)
                with open(os.path.join(args.out, fn), 'wb') as f:
                    f.write(gz)
                total_bytes += len(gz)
                seg['tiers'].append({'count': int(len(sidx)), 'file': fn, 'bytes': len(gz)})
        manifest['segments'].append(seg)
        sys.stdout.write(f'\r  segment {sg + 1}/{nseg} ({m:,} splats)   ')
        sys.stdout.flush()
    log('')

    # ---- 7. частицы шва: профиль улицы с обоих концов, протянутый через шов
    W = args.seam_width
    prof = 14.0
    a_sel = np.nonzero((p[:, 0] > s_hi - W - prof) & (p[:, 0] < s_hi - W + 2))[0]   # перед концом (sMax)
    b_sel = np.nonzero((p[:, 0] > s_lo + W - 2) & (p[:, 0] < s_lo + W + prof))[0]   # после начала (sMin)
    NP = args.seam_particles
    span = 2 * W + 8
    u = rng.random(NP)                          # 0 -> сторона sMax, 1 -> сторона sMin
    s_new = (s_hi - W - 4) + u * span           # через шов, s > sMax допустимо (кольцо периодично)
    from_b = rng.random(NP) < smoothstep(0.25, 0.75, u)
    def pick(sel, k):
        w = imp[sel] ** 1.3
        return rng.choice(sel, size=k, p=w / w.sum())
    src = np.empty(NP, np.int64)
    src[~from_b] = pick(a_sel, int((~from_b).sum()))
    src[from_b] = pick(b_sel, int(from_b.sum()))
    sp = p[src].copy()
    sp[:, 0] = s_new
    sp[:, 1] += rng.normal(0, 0.04, NP)
    sp[:, 2] += rng.normal(0, 0.04, NP)
    sp[:, 1] = np.maximum(sp[:, 1], -0.2)
    # временно подменим глобальные массивы, чтобы переиспользовать encode_chunk
    p_backup = p
    p = np.concatenate([p, sp])
    rgba_q = np.concatenate([rgba_q, rgba_q[src]])
    rgba_q[n:, 3] = np.maximum(rgba_q[n:, 3], 140)
    sc_q = np.concatenate([sc_q, np.full((NP, 3), 40, np.uint8)])
    q_q = np.concatenate([q_q, np.tile(np.array([[255, 128, 128, 128]], np.uint8), (NP, 1))])
    sidx = np.arange(n, n + NP)
    bmin = sp.min(0) - 1e-3
    ext = sp.max(0) + 1e-3 - bmin
    ranks = rng.random(NP)
    raw = encode_chunk(sidx, ranks, bmin, ext)
    seam_id = nseg
    # частицы шва — отдельным файлом: грузятся сразу после base и не задерживают первый кадр
    sgz = gzip.compress(raw, compresslevel=9, mtime=0)
    with open(os.path.join(args.out, 'seam.bin'), 'wb') as f:
        f.write(sgz)
    total_bytes += len(sgz)
    manifest['seam'] = {'id': seam_id, 'count': int(NP), 'bmin': bmin.round(4).tolist(), 'ext': ext.round(4).tolist(),
                        'file': 'seam.bin', 'bytes': len(sgz)}
    p = p_backup

    gz = gzip.compress(b''.join(base_parts), compresslevel=9, mtime=0)
    with open(os.path.join(args.out, 'base.bin'), 'wb') as f:
        f.write(gz)
    manifest['base']['bytes'] = len(gz)
    total_bytes += len(gz)
    with open(os.path.join(args.out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))

    log(f'tiers: ' + ', '.join(f't{t}={c:,}' for t, c in enumerate(tier_counts)))
    log(f'base.bin: {len(gz) / 1e6:.2f} MB ({n * tiers[1] / 1e3:.0f}k splats), seam.bin: {len(sgz) / 1e6:.2f} MB, total {total_bytes / 1e6:.1f} MB, '
        f'{total_bytes / (n + NP):.2f} B/splat; done in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
