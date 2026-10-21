// Game coordinates to a map image's pixels: an affine fit from reference
// points (three or more, not in a line), least squares when there are more,
// so a screenshot works whatever its size, crop or the map's orientation.
// T = [a, b, c, d, e, f]: px = a*X + b*Y + c, py = d*X + e*Y + f.

// Solve the 3x3 system M v = r (Cramer's rule); null when singular.
function solve3(M, r) {
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-9) return null;
  return [0, 1, 2].map((col) => det(M.map((row, i) => row.map((v, j) => (j === col ? r[i] : v)))) / D);
}

// The fit of `pairs` ([{ world: [X, Y], img: [x, y] }]), and its worst error
// in image pixels; null with fewer than three usable points.
function fitAffine(pairs) {
  if (!pairs || pairs.length < 3) return null;
  // Centre the world coordinates: they run to hundreds of thousands.
  const cx = pairs.reduce((s, p) => s + p.world[0], 0) / pairs.length;
  const cy = pairs.reduce((s, p) => s + p.world[1], 0) / pairs.length;
  const rows = pairs.map((p) => [p.world[0] - cx, p.world[1] - cy, 1]);
  const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const rx = [0, 1, 2].map((i) => rows.reduce((s, r, k) => s + r[i] * pairs[k].img[0], 0));
  const ry = [0, 1, 2].map((i) => rows.reduce((s, r, k) => s + r[i] * pairs[k].img[1], 0));
  const u = solve3(M, rx);
  const v = solve3(M, ry);
  if (!u || !v) return null;
  // Back from centred coordinates.
  const T = [u[0], u[1], u[2] - u[0] * cx - u[1] * cy, v[0], v[1], v[2] - v[0] * cx - v[1] * cy];
  const error = Math.max(...pairs.map((p) => {
    const [x, y] = apply(T, p.world);
    return Math.hypot(x - p.img[0], y - p.img[1]);
  }));
  return { T, error };
}

function apply(T, [X, Y]) {
  return [T[0] * X + T[1] * Y + T[2], T[3] * X + T[4] * Y + T[5]];
}

// Image pixels back to game coordinates.
function invert(T, [x, y]) {
  const det = T[0] * T[4] - T[1] * T[3];
  if (!det) return [NaN, NaN];
  const dx = x - T[2];
  const dy = y - T[5];
  return [(T[4] * dx - T[1] * dy) / det, (-T[3] * dx + T[0] * dy) / det];
}

if (typeof module !== "undefined") module.exports = { fitAffine, apply, invert };
