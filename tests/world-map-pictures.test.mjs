import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const dir = new URL("../src-tauri/bundled-plugins/world-map/", import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), "utf8");

// The pieces of the World Map that place markers on a picture: the maps'
// known places, the shipped pictures' fits, affine.js, and plugin.js's
// dragged fit (its `roughT`), taken out of the page it lives in.
const context = vm.createContext({ module: {} });
vm.runInContext(`${read("maps.js")}\nthis.MAPS = MAPS;`, context);
vm.runInContext(`${read("local/maps/pictures.js")}\nthis.PICTURES = LOCAL_PICTURES;`, context);
vm.runInContext(read("affine.js"), context);
vm.runInContext(`${read("plugin.js").match(/function roughT\(r\) \{[\s\S]*?\n\}/)[0]}\nthis.roughT = roughT;`, context);
const { MAPS, PICTURES, roughT, apply } = context;

// The dragged fit had game Y up the picture, so every map started out
// mirrored top to bottom; the game's map has it down, as northUp() reads it.
test("a dragged fit with no turn or mirror has game Y down the picture, as the game's map", () => {
  const T = roughT({ scale: 1, aspect: 1, rot: 0, flip: false, tx: 0, ty: 0 });
  assert.deepEqual(Array.from(apply(T, [10, 20])), [10, 20]);
});

for (const [map, name] of [[1010, "Verteron"], [1110, "Altgard"]]) {
  test(`${name}'s picture comes lined up: north up, and every Kibelisk on it`, () => {
    const p = PICTURES[map];
    assert.ok(p, `no shipped picture for ${map}`);
    const T = roughT(p.rough);
    // northUp() in plugin.js: what the minimap needs to follow you.
    assert.ok(T[0] > 0 && T[4] > 0 && Math.abs(T[1]) < 0.02 * T[0] && Math.abs(T[3]) < 0.02 * T[4], `not north up: ${T}`);
    const kibelisks = MAPS[map].kibelisks;
    assert.ok(kibelisks.length > 20);
    for (const k of kibelisks) {
      const [x, y] = apply(T, [k.x, k.y]);
      assert.ok(x >= 0 && y >= 0 && x < p.w && y < p.h, `${k.name} off the picture at ${x}, ${y}`);
    }
  });
}
