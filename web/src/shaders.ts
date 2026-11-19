// GLSL. Математика изгиба и «проявления» должна совпадать с ring.ts / sort.worker.ts.

export const SPLAT_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

uniform usampler2D u_texA;   // [x16|y16], [z16|rank16], rgba8, quat8x4
uniform usampler2D u_texB;   // sx8|sy8|sz8|seg8
uniform sampler2D  u_seg;    // на сегмент 2 текселя: (bmin.xyz, partOnly), (ext.xyz, 0)
uniform mat4 u_view;
uniform mat4 u_proj;
uniform vec2 u_focal;
uniform vec2 u_viewport;
uniform vec4 u_ring;    // sCam, kappa, L, sMin
uniform vec4 u_ring2;   // sMax, seamWidth, time, globalAlpha
uniform vec4 u_dens;    // densNear, densFar, farDensity, densPow   (кривая: max(far, min(1, (near/d)^pow)))
uniform vec4 u_part;    // partNear, partFar, dotPx, partAlpha
uniform vec4 u_seam;    // seamInner, seamOuter, seamDensity, twinkle
uniform vec4 u_seamP;   // seamPDensNear, seamPDensFar, exposure, maxRadiusPx
uniform vec4 u_lat;     // latCenter, latInner, latOuter, latDensity
uniform vec4 u_misc;    // scaleLogMin, scaleLogStep, dotWorld, clock (сек, для «прибытия» данных)
uniform vec4 u_float;   // scatterBase, scatterPerM, driftNear, driftFar — «лимбо»
uniform highp sampler2D u_birth; // время заливки каждой страницы пула (строки текстуры)
uniform vec4 u_motion;  // скорость прилёта (1/с), доля «собирающихся» у порога, -, -

layout(location = 0) in uint a_index;

out vec4 v_color;
out vec2 v_pos;

float wrapd(float d, float L) { return d - L * floor(d / L + 0.5); }

uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

void main() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // по умолчанию — за отсечением
  uint idx = a_index;
  ivec2 tc = ivec2(int(idx & 2047u), int(idx >> 11u));
  uvec4 A = texelFetch(u_texA, tc, 0);
  uint B = texelFetch(u_texB, tc, 0).r;
  int seg = int(B >> 24u);
  vec4 sb = texelFetch(u_seg, ivec2(seg * 2, 0), 0);
  vec4 se = texelFetch(u_seg, ivec2(seg * 2 + 1, 0), 0);
  vec3 p = sb.xyz + vec3(float(A.x & 0xffffu), float(A.x >> 16u), float(A.y & 0xffffu)) * (se.xyz / 65535.0);
  float rank = float(A.y >> 16u) / 65535.0;
  bool partOnly = sb.w > 0.5;

  float sCam = u_ring.x, kappa = u_ring.y, L = u_ring.z, sMin = u_ring.w, sMax = u_ring2.x;
  float d = wrapd(p.x - sCam, L);
  float ad = abs(d);

  // ---- «проявление»
  //  dens — доля видимых сплатов (по рангу); pf — насколько сплат сжат в точку (по расстоянию);
  //  em   — насколько сплат «собрался» на своём месте: 0 — парит частицей в воздухе, 1 — на месте.
  //  Каждый сплат рождается частицей у порога видимости и слетается на место по мере приближения.
  float dens, pf, densEm;
  if (partOnly) {
    float t = smoothstep(u_part.x * 0.5, u_dens.y, ad);
    dens = mix(u_seamP.x, u_seamP.y, t);
    float e = abs(wrapd(p.x - sMax, L));
    dens *= 1.0 - smoothstep(u_ring2.y * 0.75, u_ring2.y + 4.0, e);
    densEm = -1.0;
    pf = 1.0;
  } else {
    float raw = pow(u_dens.x / max(ad, 1e-3), u_dens.w);
    float de = min(p.x - sMin, sMax - p.x);
    float sm = 1.0 - smoothstep(u_seam.x, u_seam.y, de);
    float lt = smoothstep(u_lat.y, u_lat.z, abs(p.z - u_lat.x));
    float lim = min(mix(1.0, u_seam.z, sm), mix(1.0, u_lat.w, lt));
    dens = min(max(u_dens.z, min(1.0, raw)), lim);
    densEm = min(raw, lim); // без ограничения сверху: рядом всё гарантированно «собрано»
    pf = max(max(smoothstep(u_part.x, u_part.y, ad), sm), lt);
  }
  float fade = 1.0 - smoothstep(dens * 0.82, dens, rank);
  if (fade <= 0.002) return;

  uint hsh = pcg(idx);
  uint hsh2 = pcg(hsh);
  float rnd = float(hsh & 0xffffu) / 65535.0;
  float rnd2 = float(hsh >> 16u) / 65535.0;
  float rnd3 = float(hsh2 & 0xffffu) / 65535.0;
  float time = u_ring2.z;

  // догруженные куски не «вспыхивают», а прилетают роем (~1.5 с, с разбросом по сплатам)
  float birth = texelFetch(u_birth, ivec2(int(idx >> 11u), 0), 0).r;
  float arrive = clamp((u_misc.w - birth) * u_motion.x - rnd * 0.45, 0.0, 1.0);
  arrive = arrive * arrive * (3.0 - 2.0 * arrive);
  // «собираются» только самые новые сплаты на данной дистанции (доля u_motion.y) — у порога видимости
  float em = (densEm < 0.0 ? 0.45 : 1.0 - smoothstep(densEm * (1.0 - u_motion.y), densEm, rank)) * arrive;
  fade *= min(1.0, arrive * 4.0);
  float pfE = max(pf, 1.0 - em);

  // ---- изгиб улицы в колесо
  float th = kappa * d;
  float sn = sin(th), cs = cos(th), hs = sin(0.5 * th);
  float sinc = abs(th) < 1e-6 ? 1.0 : sn / th;
  float cosc = abs(th) < 1e-6 ? 0.5 * th : 2.0 * hs * hs / th;
  float h = p.y;
  vec3 W = vec3(d * sinc - h * sn, d * cosc + h * cs, p.z);
  float kh = 1.0 - h * kappa;
  float axle = smoothstep(0.03, 0.16, kh);

  // ---- «лимбо»: несобранные частицы смещены со своих мест и медленно парят; вдали — сильнее
  vec3 rdir = vec3(rnd, rnd2, rnd3) * 2.0 - 1.0;
  float farT = smoothstep(u_part.y * 0.4, u_part.y * 2.2, ad); // ~25 м → ~140 м: средний план читается, дальний парит
  float scatter = (1.0 - em) * (u_float.x + ad * u_float.y);
  float drift = u_float.z * pfE + u_float.w * farT;
  vec3 wob = vec3(
    sin(time * (0.23 + 0.17 * rnd) + rnd2 * 6.2831 + W.x * 0.07),
    sin(time * (0.19 + 0.15 * rnd2) + rnd3 * 6.2831 + W.z * 0.09),
    sin(time * (0.21 + 0.13 * rnd3) + rnd * 6.2831 + W.y * 0.08));
  W += rdir * scatter + wob * drift;

  vec4 cv = u_view * vec4(W, 1.0);
  float z = -cv.z;
  if (z < 0.1) return;
  vec4 clip = u_proj * cv;
  vec2 ndc = clip.xy / clip.w;

  vec4 col = vec4(float(A.z & 255u), float((A.z >> 8u) & 255u), float((A.z >> 16u) & 255u), float(A.z >> 24u)) / 255.0;
  // вдали (pf) частицы подсвечены, чтобы читались как «звёзды»; летящие на место — лишь чуть ярче
  float alpha = mix(col.a, max(col.a, u_part.w), pf);
  alpha = mix(alpha, min(1.0, alpha * 2.0), 1.0 - em);
  float tw = 1.0 - u_seam.w * pfE * (0.5 + 0.5 * sin(time * (0.8 + 1.7 * rnd) + rnd2 * 6.2831));
  alpha *= fade * axle * tw * u_ring2.w;
  if (alpha < 1.0 / 255.0) return;

  // ---- 2D-ковариация (в пикселях)
  float dotPx = max(u_part.z, u_misc.z * u_focal.y / z);
  float dot2 = dotPx * dotPx;
  float a2 = dot2, b2 = 0.0, c2 = dot2;
  if (pfE < 0.999) {
    vec4 q = vec4(float(A.w & 255u), float((A.w >> 8u) & 255u), float((A.w >> 16u) & 255u), float(A.w >> 24u)) / 127.5 - 1.0;
    q = normalize(q); // (w, x, y, z)
    vec3 sc = exp(u_misc.x + u_misc.y * vec3(float(B & 255u), float((B >> 8u) & 255u), float((B >> 16u) & 255u)));
    float qw = q.x, qx = q.y, qy = q.z, qz = q.w;
    mat3 R = mat3(
      1.0 - 2.0 * (qy * qy + qz * qz), 2.0 * (qx * qy + qw * qz), 2.0 * (qx * qz - qw * qy),
      2.0 * (qx * qy - qw * qz), 1.0 - 2.0 * (qx * qx + qz * qz), 2.0 * (qy * qz + qw * qx),
      2.0 * (qx * qz + qw * qy), 2.0 * (qy * qz - qw * qx), 1.0 - 2.0 * (qx * qx + qy * qy));
    mat3 M = R * mat3(sc.x, 0.0, 0.0, 0.0, sc.y, 0.0, 0.0, 0.0, sc.z);
    mat3 Jb = mat3(kh * cs, kh * sn, 0.0, -sn, cs, 0.0, 0.0, 0.0, 1.0); // якобиан изгиба
    mat3 T = mat3(u_view) * Jb * M;
    mat3 Sv = T * transpose(T);
    float iz = 1.0 / z;
    vec3 j0 = vec3(u_focal.x * iz, 0.0, u_focal.x * cv.x * iz * iz);
    vec3 j1 = vec3(0.0, u_focal.y * iz, u_focal.y * cv.y * iz * iz);
    vec3 s0 = Sv * j0;
    vec3 s1 = Sv * j1;
    // сжатие в точку: сигма убывает как (1-pf)^1.5 — крупные сплаты быстро становятся частицами,
    // а не размытыми пятнами
    float keep = (1.0 - pfE) * (1.0 - pfE) * (1.0 - pfE);
    a2 = (dot(j0, s0) + 0.3) * keep + dot2 * pfE;
    b2 = dot(j0, s1) * keep;
    c2 = (dot(j1, s1) + 0.3) * keep + dot2 * pfE;
  }

  float mid = 0.5 * (a2 + c2);
  float rad = length(vec2(0.5 * (a2 - c2), b2));
  float l1 = mid + rad;
  float l2 = max(mid - rad, 0.05);
  vec2 v1 = abs(b2) < 1e-6 ? (a2 >= c2 ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b2, l1 - a2));
  vec2 v2 = vec2(-v1.y, v1.x);
  float r1 = min(sqrt(l1), u_seamP.w);
  float r2 = min(sqrt(l2), u_seamP.w);
  // радиус квада (в сигмах), где гауссиана падает ниже 1/255 — экономит заливку
  float k = min(sqrt(max(2.0 * log(alpha * 255.0), 0.0)), 3.33);
  vec2 ext = vec2(r1 * k) * 2.0 / u_viewport;
  if (abs(ndc.x) - ext.x > 1.0 || abs(ndc.y) - ext.y > 1.0) return;

  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec2 offPx = corner.x * r1 * k * v1 + corner.y * r2 * k * v2;
  gl_Position = vec4(ndc + offPx * 2.0 / u_viewport, 0.0, 1.0);
  v_pos = corner * k;
  vec3 rgb = col.rgb * u_seamP.z;
  rgb = mix(rgb, rgb * 1.3 + 0.04, pfE * 0.7); // частицы чуть светятся
  v_color = vec4(rgb, alpha);
}
`;

export const SPLAT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_pos;
out vec4 o;
void main() {
  float g = exp(-0.5 * dot(v_pos, v_pos)) * v_color.a;
  if (g < 1.0 / 255.0) discard;
  o = vec4(v_color.rgb * g, g);
}
`;
