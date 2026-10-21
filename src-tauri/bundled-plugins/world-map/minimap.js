// Finding you on the map by the game's minimap: its terrain, seen in the
// game's top-right corner (a2.map.minimap), is looked for on the map's picture
// near where you were. The minimap is north up and scales with the game's
// height; your view cone, your circle and the icons on it are left out.
//
// The terrain is compared as its shape (a high-pass of its brightness), by
// normalised cross-correlation over the pixels kept: so a brighter or darker
// minimap still matches its place on the picture.

const MINIMAP = {
  // The terrain, as parts of the game's height, from its right edge (x) and
  // its top (y); the quest icons' column on the right is left out. Measured
  // on screenshots 1080 and 1007 tall (2026-10-21).
  box: { left: 0.236, right: 0.05, top: 0.088, bottom: 0.216 },
  // Your arrow, the minimap's centre, and your circle's radius.
  arrow: { x: 0.128, y: 0.159 },
  circle: 0.028,
  // World units per minimap pixel, times the game's height, at the minimap's
  // zoom 2 (about 90 units a pixel at 1080 tall). Learned as it is used.
  units: 93000,
  // The shape compared: brightness less its blur over this many units.
  detail: 700,
};

// The minimap's terrain in a capture of the game's corner (`shot`: width,
// height, data as RGBA), the corner being the game's top-right, of a game
// picture gameW × gameH: brightness, which pixels are terrain, and where your
// arrow is.
function minimapView(shot, gameW, gameH) {
  const H = gameH;
  const left = shot.width - MINIMAP.box.left * H;
  const x0 = Math.max(0, Math.round(left));
  const x1 = Math.min(shot.width, Math.round(shot.width - MINIMAP.box.right * H));
  const y0 = Math.max(0, Math.round(MINIMAP.box.top * H));
  const y1 = Math.min(shot.height, Math.round(MINIMAP.box.bottom * H));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 16 || h < 16) return null;
  const ax = shot.width - MINIMAP.arrow.x * H - x0;
  const ay = MINIMAP.arrow.y * H - y0;
  const r2 = (MINIMAP.circle * H + 6) ** 2;
  const gray = new Float32Array(w * h);
  const keep = new Uint8Array(w * h);
  let kept = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y + y0) * shot.width + x + x0) * 4;
      const r = shot.data[i];
      const g = shot.data[i + 1];
      const b = shot.data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      gray[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      // Terrain: coloured or dark (the view cone whitens what it covers,
      // so a pale grey pixel may be under it; grey rock in shadow is not),
      // not the white frame and icons, not the teal ring and markers, and
      // outside your circle. Measured on sand and on grey rock (2026-10-21).
      const terrain = max > 0 && ((max - min) / max > 0.27 || max < 150) && max < 215 && !(g > r + 20 && b > r + 20)
        && (x - ax) ** 2 + (y - ay) ** 2 > r2;
      if (terrain) {
        keep[y * w + x] = 1;
        kept++;
      }
    }
  }
  return { w, h, gray, keep, ax, ay, kept: kept / (w * h) };
}

// A w × h brightness (and which pixels count) shrunk by f (at most 1), each
// pixel the mean of those it covers; a pixel counts only if all of those do.
function shrink(gray, keep, w, h, f) {
  const w2 = Math.max(1, Math.floor(w * f));
  const h2 = Math.max(1, Math.floor(h * f));
  const g2 = new Float32Array(w2 * h2);
  const k2 = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const ya = Math.floor(y / f);
    const yb = Math.max(ya + 1, Math.floor((y + 1) / f));
    for (let x = 0; x < w2; x++) {
      const xa = Math.floor(x / f);
      const xb = Math.max(xa + 1, Math.floor((x + 1) / f));
      let s = 0;
      let n = 0;
      let all = 1;
      for (let yy = ya; yy < yb && yy < h; yy++) {
        for (let xx = xa; xx < xb && xx < w; xx++) {
          s += gray[yy * w + xx];
          n++;
          if (keep && !keep[yy * w + xx]) all = 0;
        }
      }
      g2[y * w2 + x] = n ? s / n : 0;
      k2[y * w2 + x] = all;
    }
  }
  return { w: w2, h: h2, gray: g2, keep: k2 };
}

// a less its blur (three box blurs, close to a Gaussian of `sigma` pixels).
function highPass(a, w, h, sigma) {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  let src = Float32Array.from(a);
  let tmp = new Float32Array(a.length);
  const pass = (from, to, stride, count, len) => {
    for (let line = 0; line < count; line++) {
      const base = stride === 1 ? line * len : line;
      const step = stride === 1 ? 1 : count;
      let s = 0;
      for (let i = -r; i <= r; i++) s += from[base + Math.min(len - 1, Math.max(0, i)) * step];
      for (let i = 0; i < len; i++) {
        to[base + i * step] = s / (2 * r + 1);
        s += from[base + Math.min(len - 1, i + r + 1) * step] - from[base + Math.max(0, i - r) * step];
      }
    }
  };
  for (let n = 0; n < 3; n++) {
    pass(src, tmp, 1, h, w);
    pass(tmp, src, w, w, h);
  }
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - src[i];
  return out;
}

// The template t (tw × th, counting `keep`) laid on img (iw × ih) at each
// offset from (0, 0) to (nx - 1, ny - 1): the best, its score, and the best
// score away from it (`second`, at least `apart` pixels off), which says how
// sure it is. The best is placed between pixels by the scores around it.
function matchNcc(img, iw, t, keep, tw, th, nx, ny, apart) {
  const off = [];
  const val = [];
  let mean = 0;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      if (!keep[y * tw + x]) continue;
      off.push(y * iw + x);
      val.push(t[y * tw + x]);
      mean += t[y * tw + x];
    }
  }
  const n = val.length;
  if (n < 50) return null;
  mean /= n;
  let tt = 0;
  for (let k = 0; k < n; k++) {
    val[k] -= mean;
    tt += val[k] * val[k];
  }
  const offs = Int32Array.from(off);
  const vals = Float32Array.from(val);
  const scores = new Float32Array(nx * ny).fill(-1);
  let best = -1;
  let bx = 0;
  let by = 0;
  for (let oy = 0; oy < ny; oy++) {
    for (let ox = 0; ox < nx; ox++) {
      const base = oy * iw + ox;
      let s = 0;
      let si = 0;
      let sii = 0;
      for (let k = 0; k < n; k++) {
        const v = img[base + offs[k]];
        s += vals[k] * v;
        si += v;
        sii += v * v;
      }
      const spread = sii - (si * si) / n;
      const score = spread > 1e-6 ? s / Math.sqrt(tt * spread) : -1;
      scores[oy * nx + ox] = score;
      if (score > best) [best, bx, by] = [score, ox, oy];
    }
  }
  let second = -1;
  for (let oy = 0; oy < ny; oy++) {
    for (let ox = 0; ox < nx; ox++) {
      if ((ox - bx) ** 2 + (oy - by) ** 2 >= apart * apart) second = Math.max(second, scores[oy * nx + ox]);
    }
  }
  const at = (x, y) => (x >= 0 && y >= 0 && x < nx && y < ny ? scores[y * nx + x] : best);
  const peak = (a, b, c) => {
    const d = a - 2 * b + c;
    return d < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0;
  };
  return {
    score: best,
    second,
    x: bx + peak(at(bx - 1, by), best, at(bx + 1, by)),
    y: by + peak(at(bx, by - 1), best, at(bx, by + 1)),
  };
}

// Where you are, by a minimap `view` whose pixels are k world units, looked
// for within `radius` units of `near` ([x, y]). `grab(x0, y0, x1, y1, w, h)`
// gives the map picture's brightness over that world rect as w × h pixels,
// north up. Compared at u units a pixel (twice the minimap's, by default).
function minimapLocate(view, { k, near, radius, grab, u = k * 2 }) {
  const f = k / u;
  const t = shrink(view.gray, view.keep, view.w, view.h, f);
  const ax = view.ax * f;
  const ay = view.ay * f;
  const r = Math.max(2, Math.ceil(radius / u));
  const iw = t.w + 2 * r;
  const ih = t.h + 2 * r;
  const x0 = near[0] - (ax + r) * u;
  const y0 = near[1] - (ay + r) * u;
  const map = grab(x0, y0, x0 + iw * u, y0 + ih * u, iw, ih);
  if (!map) return null;
  const sigma = MINIMAP.detail / u;
  const m = matchNcc(highPass(map, iw, ih, sigma), iw, highPass(t.gray, t.w, t.h, sigma), t.keep, t.w, t.h, 2 * r + 1, 2 * r + 1, Math.max(3, 1500 / u));
  if (!m) return null;
  return { x: x0 + (m.x + ax) * u, y: y0 + (m.y + ay) * u, score: m.score, second: m.second, k };
}

// Whether a match is to be believed: a clear best, well above the rest.
const minimapSure = (m) => !!m && m.score >= 0.4 && m.score - m.second >= 0.12;

if (typeof module !== "undefined") module.exports = { MINIMAP, minimapView, shrink, highPass, matchNcc, minimapLocate, minimapSure };
