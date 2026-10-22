#!/usr/bin/env node
// Builds the World Map's own pictures from map tile packs saved from
// gaming.tools (`world_l_a.gtpk` and the like, saved from your own browser),
// so a map has its picture, lined up, from the start. Personal: committed
// only to this private repository, so its installers have them; never to a
// public one.
//
//   npm install --no-save sharp
//   node tools/world_map_pictures.cjs ~/Downloads/world_l_a.gtpk 1010 [width] [--bounds=minX,minY,maxX,maxY]
//
// Writes src-tauri/bundled-plugins/world-map/local/maps/<map>.webp from the
// pack's sharpest zoom that has every tile (one saved from the browser's
// cache has only the tiles it had loaded), shrunk to `width` (8192 unless
// given): the map window holds the whole picture in memory, 4 bytes a pixel.
// And its fit in local/maps/pictures.js: the pack's picture covers `bounds`
// in game coordinates (gaming.tools' map list says, ±408,000 for Verteron
// and Altgard), game X along it and game Y down it, sized to fit as their
// map sizes it. A picture you add yourself in the app takes its place.
//
// A pack: "GTPK", version, tile count, tile size, 0, deepest zoom, width,
// height, index entry size, index offset; then per tile (zoom, column, row,
// offset low, offset high, length), each tile a WebP.
const fs = require("fs");
const path = require("path");

// WebP's own limit.
const MAX_WEBP = 16383;

const args = process.argv.slice(2);
const [file, map, width = "8192"] = args.filter((a) => !a.startsWith("--"));
const boundsArg = args.find((a) => a.startsWith("--bounds="));
const [minX, minY, maxX, maxY] = boundsArg ? boundsArg.slice(9).split(",").map(Number) : [-408000, -408000, 408000, 408000];
if (!file || !/^\d+$/.test(map || "") || !/^\d+$/.test(width) || !(maxX > minX && maxY > minY)) {
  console.error("usage: node tools/world_map_pictures.cjs <pack>.gtpk <map number> [width] [--bounds=minX,minY,maxX,maxY]");
  process.exit(1);
}
let sharp;
try {
  sharp = require("sharp");
} catch {
  console.error("needs sharp: npm install --no-save sharp");
  process.exit(1);
}

const pack = fs.readFileSync(file);
if (pack.toString("latin1", 0, 4) !== "GTPK") {
  console.error(`${file}: not a .gtpk tile pack`);
  process.exit(1);
}
const u32 = (at) => pack.readUInt32LE(at);
const [count, tile, deepest, fullWidth, fullHeight, entry, index] = [8, 12, 20, 24, 28, 32, 36].map(u32);

// Each zoom's tiles, and whether every one of them is there.
const zooms = new Map();
for (let i = 0; i < count; i++) {
  const at = index + i * entry;
  const [zoom, col, row, lo, hi, size] = [0, 4, 8, 12, 16, 20].map((o) => u32(at + o));
  const start = lo + hi * 2 ** 32;
  const z = zooms.get(zoom) || { tiles: [], missing: 0 };
  if (pack.toString("latin1", start, start + 4) === "RIFF") z.tiles.push({ col, row, data: pack.subarray(start, start + size) });
  else z.missing++;
  zooms.set(zoom, z);
}
const sizeAt = (zoom) => [Math.ceil(fullWidth / 2 ** (deepest - zoom)), Math.ceil(fullHeight / 2 ** (deepest - zoom))];
const complete = (zoom) => {
  const z = zooms.get(zoom);
  const [w, h] = sizeAt(zoom);
  return !!z && !z.missing && z.tiles.length === Math.ceil(w / tile) * Math.ceil(h / tile);
};
// The smallest whole zoom at least as wide as wanted, else the sharpest whole one.
const wanted = Math.min(Number(width), MAX_WEBP);
const whole = [...zooms.keys()].filter(complete).sort((a, b) => a - b);
const zoom = whole.find((z) => sizeAt(z)[0] >= wanted) ?? whole.at(-1);
if (zoom === undefined) {
  console.error(`${file}: no zoom has all its tiles; save the pack again, bypassing the cache`);
  process.exit(1);
}
if (zoom < deepest) {
  const missing = zooms.get(deepest)?.missing || 0;
  if (missing && sizeAt(zoom)[0] < wanted) {
    console.log(`${path.basename(file)}: ${missing} of the sharpest tiles missing, so zoom ${zoom} (save the pack again, bypassing the cache, for a sharper one)`);
  }
}

(async () => {
  const [w, h] = sizeAt(zoom);
  const tiles = zooms.get(zoom).tiles.map((t) => ({ input: t.data, left: t.col * tile, top: t.row * tile }));
  const stitched = await sharp({ create: { width: w, height: h, channels: 3, background: "#000" }, limitInputPixels: false })
    .composite(tiles)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let picture = sharp(stitched.data, { raw: stitched.info, limitInputPixels: false });
  if (w > wanted) picture = picture.resize({ width: wanted });
  const out = path.join(__dirname, "../src-tauri/bundled-plugins/world-map/local/maps");
  fs.mkdirSync(out, { recursive: true });
  for (const old of ["png", "jpg", "webp"]) fs.rmSync(path.join(out, `${map}.${old}`), { force: true });
  const target = path.join(out, `${map}.webp`);
  const info = await picture.webp({ quality: 85 }).toFile(target);
  console.log(`${path.basename(file)}: map ${map}, zoom ${zoom}, ${info.width}×${info.height}, ${(info.size / 1048576).toFixed(1)} MB`);
  console.log(`wrote ${target}`);

  // The fit, as the World Map's dragged one (its `roughT`): on the pack's
  // whole picture, the bounds sized to fit and centred; then shrunk with it.
  const fit = Math.min(fullWidth / (maxX - minX), fullHeight / (maxY - minY));
  const k = info.width / fullWidth;
  const scale = fit * k;
  const rough = {
    scale,
    aspect: 1,
    rot: 0,
    flip: false,
    tx: ((fullWidth - (maxX - minX) * fit) / 2 - minX * fit) * k,
    ty: ((fullHeight - (maxY - minY) * fit) / 2 - minY * fit) * k,
  };
  const fits = path.join(out, "pictures.js");
  let pictures = {};
  try {
    const text = fs.readFileSync(fits, "utf8");
    pictures = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {}
  pictures[map] = { w: info.width, h: info.height, rough };
  fs.writeFileSync(fits, `// Made by tools/world_map_pictures.cjs: the World Map's own pictures, by map, and each one's fit. Personal: keep it private.\nconst LOCAL_PICTURES = ${JSON.stringify(pictures)};\n`);
  console.log(`wrote ${fits}`);
})().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
