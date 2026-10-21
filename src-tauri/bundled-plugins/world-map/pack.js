// A map file you saved from gaming.tools' map (`<map>.d.json`, from your own
// browser): every spawn of the map's Hidden Cubes, gathering, Empyrean
// Traces, monsters and places, in game coordinates. It is read here and kept
// in this plugin's storage on your computer; nothing of it ships with the app.

// The layers drawn from it, in the order listed. `types` are the file's own
// type ids; "pet" takes the monsters Pet Soul Tracker lists for the map.
const PACK_LAYERS = [
  { key: "cube", group: "Collectables", label: "Hidden Cubes", color: "#ffd36b", shape: "square", on: true, types: ["hiddencube"] },
  { key: "trace", group: "Collectables", label: "Empyrean Traces", color: "#7fe7ff", shape: "diamond", on: true, types: ["monolithfragment_incomplete"] },
  { key: "ore", group: "Gathering", label: "Ore", color: "#c0c8d4", on: true, types: ["resource-metal"] },
  { key: "gem", group: "Gathering", label: "Gems", color: "#a98bff", on: true, types: ["resource-jewelry"] },
  { key: "odyle", group: "Gathering", label: "Odyle", color: "#6fa8ff", on: true, types: ["resource-od"] },
  { key: "herb", group: "Gathering", label: "Herbs", color: "#7be07b", on: true, types: ["resource-herb"] },
  { key: "log", group: "Gathering", label: "Logs", color: "#c99a62", on: true, types: ["resource-tree"] },
  { key: "fruit", group: "Gathering", label: "Fruit", color: "#ff8a6b", on: true, types: ["resource-berry"] },
  { key: "vegetable", group: "Gathering", label: "Vegetables", color: "#d6e86b", on: true, types: ["resource-vegetable"] },
  { key: "aquatic", group: "Gathering", label: "Aquatic life", color: "#5fe3c8", on: true, types: ["resource-shellfish"] },
  { key: "pet", group: "Monsters", label: "Pet soul monsters", color: "#ff7fb6", on: true, types: [] },
  { key: "heroic", group: "Monsters", label: "Heroic monsters", color: "#ff6b6b", on: false, types: ["monster-rank-heromonster"] },
  { key: "elite", group: "Monsters", label: "Elite monsters", color: "#ffb36b", on: false, types: ["monster-rank-elitemonster"] },
  { key: "common", group: "Monsters", label: "Common monsters", color: "#a7adb8", on: false, types: ["monster-rank-normalmonster"] },
  { key: "dungeon", group: "Places", label: "Dungeons", color: "#ffffff", shape: "ring", on: false, types: ["dungeon", "sealed-dungeon"] },
  { key: "stronghold", group: "Places", label: "Strongholds", color: "#ffffff", shape: "ring", on: false, types: ["stronghold"] },
  { key: "rift", group: "Places", label: "Spacetime Rifts", color: "#c9a6ff", shape: "ring", on: false, types: ["rift"] },
  { key: "flight", group: "Places", label: "Flight Circles", color: "#8fc2ff", shape: "ring", on: false, types: ["flightring"] },
  { key: "portal", group: "Places", label: "Teleportation Portals", color: "#8fc2ff", shape: "ring", on: false, types: ["movemapcondition"] },
  { key: "monolith", group: "Places", label: "Monoliths", color: "#7fe7ff", shape: "ring", on: false, types: ["monolith"] },
  { key: "event", group: "Places", label: "Field events", color: "#ffd36b", shape: "ring", on: false, types: ["fieldevent"] },
  { key: "heroquest", group: "Quests and people", label: "Hero quests", color: "#ffd36b", shape: "diamond", on: false, types: ["heroquest"] },
  { key: "districtquest", group: "Quests and people", label: "Regional quests", color: "#9fe39f", shape: "diamond", on: false, types: ["districtquest"] },
  { key: "service", group: "Quests and people", label: "Merchants and storage", color: "#e3e3e3", shape: "square", on: false, types: ["shop", "storage"] },
  { key: "craft", group: "Quests and people", label: "Crafting tables", color: "#c99a62", shape: "square", on: false, types: ["blacksmith", "tailor", "jewelcraft", "alchemy", "cook"] },
  { key: "npc", group: "Quests and people", label: "Other NPCs", color: "#a7adb8", on: false, types: ["npc-other", "npc-npcteleport"] },
  { key: "region", group: "Quests and people", label: "Region names", color: "#ffffff", shape: "text", on: false, types: ["village", "battlefield"] },
];

// The file's format (devalue): a flat array, every value referred to by its
// index, the root first. Negative indices are undefined, NaN and the like.
function undevalue(arr) {
  const memo = new Map();
  const at = (i) => {
    if (!Number.isInteger(i) || i < 0 || i >= arr.length) return undefined;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (Array.isArray(v)) {
      const out = [];
      memo.set(i, out);
      for (const x of v) out.push(at(x));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      memo.set(i, out);
      for (const [k, x] of Object.entries(v)) out[k] = at(x);
      return out;
    }
    memo.set(i, v);
    return v;
  };
  return at(0);
}

// What a parsed JSON value is, of gaming.tools' files: "map" (one map's
// markers), "maps" (their list of maps), "search" (their search index), or null.
function packKind(v) {
  const head = Array.isArray(v) && v[0] && typeof v[0] === "object" && !Array.isArray(v[0]) ? v[0] : null;
  if (!head || !Object.values(head).every(Number.isInteger)) return null;
  if ("points" in head || "groups" in head) return "map";
  if ("maps" in head && "categories" in head) return "maps";
  if ("entries" in head) return "search";
  return null;
}

// One map's file as kept: { map, entries: [{ t, n, xy, id?, lv?, to? }] },
// `t` the file's types, `xy` its spots flat ([x, y, x, y, …]).
function packOf(v) {
  const root = undevalue(v) || {};
  const name = (o) => String(o?.name || o?.entity?.name || "").slice(0, 80);
  const entries = [];
  const add = (o, xy) => {
    const e = { t: (o.types || [o.type]).filter((t) => typeof t === "string"), n: name(o), xy };
    const id = Number(o.entity?.id);
    if (Number.isFinite(id)) e.id = id;
    if (Number.isFinite(o.entity?.level)) e.lv = o.entity.level;
    if (o.target?.name) e.to = String(o.target.name).slice(0, 80);
    if (e.t.length && xy.length >= 2) entries.push(e);
  };
  for (const g of root.groups || []) {
    const xy = (Array.isArray(g?.positions) ? g.positions : []).map(Math.round).filter(Number.isFinite);
    if (g) add(g, xy.length % 2 ? xy.slice(0, -1) : xy);
  }
  for (const p of [...(root.points || []), ...(root.labels || [])]) {
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) add(p, [Math.round(p.x), Math.round(p.y)]);
  }
  return { map: Number(root.id), entries };
}

// Each entry's layer key (null when none takes it): `pets` maps the monster
// ids of the map's pet soul monsters to the pets they drop.
function packLayerOf(e, pets) {
  if (e.id && pets.has(e.id)) return "pet";
  for (const l of PACK_LAYERS) if (l.types.some((t) => e.t.includes(t))) return l.key;
  return null;
}

if (typeof module !== "undefined") module.exports = { PACK_LAYERS, undevalue, packKind, packOf, packLayerOf };
