import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src-tauri/bundled-plugins/world-map/minimap.js", import.meta.url), "utf8");
const lib = {};
vm.runInNewContext(`${source}\nthis.lib = { MINIMAP, minimapView, minimapLocate, minimapSure };`, lib);
const { MINIMAP, minimapView, minimapLocate, minimapSure } = lib.lib;

// Terrain, at 50 world units a pixel over 2000 × 2000 pixels from (0, 0):
// rocks and hills of many sizes, as fine as the game's, seeded so each run
// is the same.
const WORLD = 2000;
const PER_PX = 50;
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const hills = Array.from({ length: 40000 }, () => ({ x: rand() * WORLD, y: rand() * WORLD, r: 1.5 + rand() ** 2 * 30, h: rand() * 50 - 25 }));
const world = new Float32Array(WORLD * WORLD).fill(120);
for (const hill of hills) {
  const r = Math.ceil(hill.r * 2.5);
  for (let y = Math.max(0, Math.floor(hill.y - r)); y < Math.min(WORLD, hill.y + r); y++) {
    for (let x = Math.max(0, Math.floor(hill.x - r)); x < Math.min(WORLD, hill.x + r); x++) {
      world[y * WORLD + x] += hill.h * Math.exp(-((x - hill.x) ** 2 + (y - hill.y) ** 2) / (2 * hill.r * hill.r));
    }
  }
}
// The map picture's brightness over a world rect, sampled w × h.
const grab = (x0, y0, x1, y1, w, h) => {
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = Math.min(WORLD - 1, Math.max(0, Math.round((x0 + ((i + 0.5) * (x1 - x0)) / w) / PER_PX)));
      const y = Math.min(WORLD - 1, Math.max(0, Math.round((y0 + ((j + 0.5) * (y1 - y0)) / h) / PER_PX)));
      out[j * w + i] = world[y * WORLD + x];
    }
  }
  return out;
};

// The game's corner as the app captures it, a game 1080 tall, you at (px, py)
// world units: sandy terrain at k units a pixel, your bright view cone to the
// north-east and your circle drawn over it.
function corner(px, py, k, gameH = 1080) {
  const w = Math.round(gameH * 0.3);
  const h = Math.round(gameH * 0.27);
  const ax = w - MINIMAP.arrow.x * gameH;
  const ay = MINIMAP.arrow.y * gameH;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wx = Math.round((px + (x - ax) * k) / PER_PX);
      const wy = Math.round((py + (y - ay) * k) / PER_PX);
      let v = world[Math.min(WORLD - 1, Math.max(0, wy)) * WORLD + Math.min(WORLD - 1, Math.max(0, wx))];
      const angle = Math.atan2(y - ay, x - ax);
      const inCone = angle > -1.2 && angle < -0.4;
      const inCircle = (x - ax) ** 2 + (y - ay) ** 2 < (MINIMAP.circle * gameH) ** 2;
      const i = (y * w + x) * 4;
      if (inCone || inCircle) data.set([240, 235, 225, 255], i);
      else data.set([v * 1.4, v * 1.1, v * 0.6, 255], i);
    }
  }
  return { width: w, height: h, data };
}

test("the minimap is found where you are, near where you were", () => {
  const you = [52_000, 47_000];
  const k = MINIMAP.units / 1080;
  const view = minimapView(corner(...you, k), 1920, 1080);
  assert.ok(view.kept > 0.5, `most of it is terrain (${view.kept})`);
  const m = minimapLocate(view, { k, near: [you[0] + 1800, you[1] - 1300], radius: 3000, grab });
  assert.ok(minimapSure(m), JSON.stringify(m));
  assert.ok(Math.hypot(m.x - you[0], m.y - you[1]) < 150, `found at ${Math.round(m.x)}, ${Math.round(m.y)}`);
});

test("somewhere else is not taken for it", () => {
  const k = MINIMAP.units / 1080;
  const view = minimapView(corner(52_000, 47_000, k), 1920, 1080);
  const m = minimapLocate(view, { k, near: [30_000, 70_000], radius: 3000, grab });
  assert.ok(!minimapSure(m), JSON.stringify(m));
});

test("a smaller game window is read at its own scale", () => {
  const gameH = 1007;
  const you = [61_000, 38_000];
  const k = MINIMAP.units / gameH;
  const view = minimapView(corner(...you, k, gameH), 1911, gameH);
  const m = minimapLocate(view, { k, near: [you[0] - 2000, you[1] + 900], radius: 3000, grab });
  assert.ok(minimapSure(m), JSON.stringify(m));
  assert.ok(Math.hypot(m.x - you[0], m.y - you[1]) < 150, `found at ${Math.round(m.x)}, ${Math.round(m.y)}`);
});
