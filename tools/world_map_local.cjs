#!/usr/bin/env node
// Builds the World Map's own copy of map files saved from gaming.tools
// (`<map>.d.json`, saved from your browser), so the map shows their spots
// without importing them. Personal: the output folder is git-ignored and
// never goes in a commit.
//
//   node tools/world_map_local.cjs ~/Downloads/1110.d.json [more .d.json…]
//
// Writes src-tauri/bundled-plugins/world-map/local/packs.js. Run it again
// with every file to keep (each run writes all of them).
const fs = require("fs");
const path = require("path");
// pack.js is a plain browser script (the package is an ES module one):
// read it as such.
const vm = require("vm");
const sandbox = {};
vm.runInNewContext(`${fs.readFileSync(path.join(__dirname, "../src-tauri/bundled-plugins/world-map/pack.js"), "utf8")}\nthis.lib = { packKind, packOf };`, sandbox);
const { packKind, packOf } = sandbox.lib;

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node tools/world_map_local.cjs <map>.d.json [...]");
  process.exit(1);
}
const packs = {};
for (const file of files) {
  const v = JSON.parse(fs.readFileSync(file, "utf8"));
  if (packKind(v) !== "map") {
    console.error(`${file}: not one map's file (the one named after its number, as 1110.d.json)`);
    process.exit(1);
  }
  const p = packOf(v);
  packs[p.map] = { saved: fs.statSync(file).mtimeMs, entries: p.entries };
  console.log(`${path.basename(file)}: map ${p.map}, ${p.entries.reduce((n, e) => n + e.xy.length / 2, 0).toLocaleString()} spots`);
}
const out = path.join(__dirname, "../src-tauri/bundled-plugins/world-map/local");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "packs.js"), `// Made by tools/world_map_local.cjs from your saved map files. Personal: not committed.\nconst LOCAL_PACKS = ${JSON.stringify(packs)};\n`);
console.log(`wrote ${path.join(out, "packs.js")}`);
