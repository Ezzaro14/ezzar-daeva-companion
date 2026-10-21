// World Map: your own screenshot of each world map (a2.map), lined up with
// the game's coordinates (affine.js), and the places known on it: Kibelisks
// and pet soul monster areas (maps.js), field bosses with their timers
// (a2.bossTimers), monsters seen in your fights and you and your party
// (the combat feed's positions), your pins and imported markers, and the
// spawns of a map file you saved from gaming.tools (pack.js).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// A spot seen again within this many game units is the same spot.
const SAME_SPOT = 2500;
const MAX_SPOTS = 30;
const MAX_SEEN = 500;
// The zoom from which a layer's markers are labelled: names that would pile
// up on a whole map wait until it is zoomed in.
const LABEL_ZOOM = { kibelisk: 0.9, monster: 2.2, seen: 2.2, imported: 1.2 };
// Without an image: game units per pixel.
const GRID_SCALE = 200;

const LAYERS = [
  ["me", "You and your party", "#2e7cff"],
  ["kibelisk", "Kibelisks", "#5fd0ff"],
  ["boss", "Field bosses", "#ff6b6b"],
  ["monster", "Pet soul monsters", "#9fe39f"],
  ["seen", "Monsters you have seen", "#c9a6ff"],
  ["pin", "Your pins", "#ffd36b"],
  ["imported", "Imported", "#e3e3e3"],
];

let prefs = { layers: Object.fromEntries(LAYERS.map(([k]) => [k, k !== "seen"])), map: null };
let mapId = null; // the map shown
let liveMap = 0; // the map you are on (its overworld map)
let live = []; // positions on it
let data = null; // the stored data of the map shown
let image = null; // { url, w, h }
let view = { zoom: 1, x: 0, y: 0 };
let follow = false;
let selected = null;
let placing = null; // "pin" | "ref"
let calibrating = null; // null | "drag" | "points"
let character = null;
let bossTimers = {};
// The map file you saved for the map shown: { saved, entries }, each entry
// with its layer (`k`); and its field bosses' spots, by name.
let pack = null;
let packBosses = {};
// calib: the fit from clicked places (T, from refs), or the dragged one (rough).
const DEFAULT_DATA = () => ({ calib: { refs: [], T: null, rough: null }, pins: [], imported: [], seen: {}, bossSpots: {} });

// The overworld map of a map id: a layer's (101001) is its base (1010).
const baseMap = (id) => (id >= 100000 ? Math.floor(id / 100) : id);
const mapName = (id) => MAPS[id]?.name || `Map ${id}`;

// ── storage ─────────────────────────────────────────────────────────────────

const store = (key, value) => a2.storage.set(key, value).catch(() => {});
let saveTimer = 0;
function saveData(soon = false) {
  clearTimeout(saveTimer);
  const id = mapId;
  const d = data;
  saveTimer = setTimeout(() => store(`map-${id}`, d), soon ? 0 : 5000);
}

async function openMap(id) {
  if (data && mapId !== null) await store(`map-${mapId}`, data);
  mapId = Number(id);
  prefs.map = mapId;
  store("prefs", prefs);
  data = { ...DEFAULT_DATA(), ...((await a2.storage.get(`map-${mapId}`).catch(() => null)) || {}) };
  dropBlankImports();
  fixRefs();
  await loadPack();
  image = null;
  const url = await a2.map.image(mapId).catch(() => null);
  if (url) await loadImage(url);
  selected = null;
  calibrating = null;
  placing = null;
  // A picture never lined up: a first guess, to drag into place.
  if (image && !data.calib?.T && !data.calib?.rough) {
    data.calib = { refs: [], T: null, ...(data.calib || {}), rough: autoRough() };
    calibrating = "drag";
  }
  renderSide();
  meShown = null;
  trail = [];
  restoreView();
}

// Places clicked to line the picture up keep the spot they had then: a
// Kibelisk's, from maps.js, which once had its spot wrong. Each is moved to
// where its Kibelisk is now, and the fit made again.
function fixRefs() {
  const refs = data.calib?.refs || [];
  const kib = new Map((MAPS[mapId]?.kibelisks || []).map((k) => [k.name, k]));
  let moved = false;
  for (const r of refs) {
    const k = kib.get(r.label);
    if (k && (r.world[0] !== k.x || r.world[1] !== k.y)) {
      r.world = [k.x, k.y];
      moved = true;
    }
  }
  if (!moved) return;
  const fit = refs.length >= 3 ? fitAffine(refs) : null;
  data.calib.T = fit ? fit.T : null;
  saveData(true);
}

function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      image = { url, w: img.naturalWidth, h: img.naturalHeight };
      resolve();
    };
    img.onerror = () => resolve();
    img.src = url;
  });
}

// ── coordinates ─────────────────────────────────────────────────────────────

// Every place known on the map shown, for its extent without an image.
function allPoints() {
  const m = MAPS[mapId] || {};
  return [
    ...(m.kibelisks || []),
    ...(m.monsters || []),
    ...(data?.pins || []),
    ...(data?.imported || []),
    ...Object.values(data?.seen || {}).flatMap((s) => s.points),
    ...(baseMap(liveMap) === mapId ? live : []),
  ].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

let grid = null; // { minX, maxY, w, h } without an image
function computeGrid() {
  const pts = allPoints();
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = (xs.length ? Math.min(...xs) : -100000) - 20000;
  const maxX = (xs.length ? Math.max(...xs) : 100000) + 20000;
  const minY = (ys.length ? Math.min(...ys) : -100000) - 20000;
  const maxY = (ys.length ? Math.max(...ys) : 100000) + 20000;
  grid = { minX, maxY, w: (maxX - minX) / GRID_SCALE, h: (maxY - minY) / GRID_SCALE };
}

// The dragged fit as a transform: north up (game Y up the picture), turned a
// quarter at a time, mirrored if asked, sized (and stretched) and moved.
function roughT(r) {
  let u = [1, 0];
  let v = [0, -1];
  for (let i = 0; i < (r.rot || 0) % 4; i++) [u, v] = [[-v[0], -v[1]], u];
  if (r.flip) u = [-u[0], -u[1]];
  const sx = r.scale;
  const sy = r.scale * (r.aspect || 1);
  return [sx * u[0], sx * u[1], r.tx, sy * v[0], sy * v[1], r.ty];
}

// The places every map has, to fit the markers to a picture by.
const knownPoints = () => {
  const m = MAPS[mapId] || {};
  return [...(m.kibelisks || []), ...(m.monsters || []), ...(m.bosses || [])].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
};

// A first guess: the known places spread over the middle of the picture,
// turned and mirrored as `r` says (or north up).
function autoRough(r = {}) {
  const base = { scale: 1, aspect: r.aspect || 1, rot: r.rot || 0, flip: !!r.flip, tx: 0, ty: 0 };
  const T = roughT(base);
  const pts = (knownPoints().length ? knownPoints() : allPoints()).map((p) => apply(T, [p.x, p.y]));
  if (!pts.length || !image) return { ...base, scale: 0.01, tx: image ? image.w / 2 : 0, ty: image ? image.h / 2 : 0 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = 0.8 * Math.min(image.w / Math.max(1, maxX - minX), image.h / Math.max(1, maxY - minY));
  return { ...base, scale, tx: (image.w - (maxX - minX) * scale) / 2 - minX * scale, ty: (image.h - (maxY - minY) * scale) / 2 - minY * scale };
}

// The fit in use: from clicked places when there are three, else the dragged one.
const transform = () => data?.calib?.T || (data?.calib?.rough ? roughT(data.calib.rough) : null);
const calibrated = () => !!(image && transform());
// Game coordinates to stage pixels: the fit on an image, north-up otherwise.
function toStage(x, y) {
  if (calibrated()) return apply(transform(), [x, y]);
  if (image) return null;
  return [(x - grid.minX) / GRID_SCALE, (grid.maxY - y) / GRID_SCALE];
}
function toWorld(px, py) {
  if (calibrated()) return invert(transform(), [px, py]);
  if (image) return null;
  return [px * GRID_SCALE + grid.minX, grid.maxY - py * GRID_SCALE];
}
const stageSize = () => (image ? { w: image.w, h: image.h } : { w: grid.w, h: grid.h });

// ── drawing ─────────────────────────────────────────────────────────────────

function markersNow() {
  const out = [];
  const m = MAPS[mapId] || {};
  const q = $(".search").value.trim().toLowerCase();
  const match = (name) => !q || String(name).toLowerCase().includes(q);
  const add = (layer, p, cls, label, info) => {
    if (!prefs.layers[layer] || !match(label)) return;
    out.push({ layer, x: p.x, y: p.y, cls, label, info });
  };
  for (const k of m.kibelisks || []) add("kibelisk", k, "kibelisk", k.name, { kind: "Kibelisk (teleport)" });
  // The map's own pet soul monsters, with every spot, replace these.
  for (const mon of pack?.kinds.pet ? [] : m.monsters || []) {
    add("monster", mon, "monster", mon.name, { kind: `Pet soul monster · level ${mon.level ?? "?"}`, more: `Souls for ${mon.pets.join(", ")} · ${mon.spawns ?? "?"} spawns · near ${mon.kibelisk}` });
  }
  for (const b of m.bosses || []) {
    const spot = data.bossSpots[b.name] || packBosses[b.name];
    const t = bossTimers[b.id];
    const up = t?.state === "up";
    if (spot) add("boss", spot, `boss${up ? " up" : ""}`, b.name, { kind: `Field boss · level ${b.level ?? "?"}`, more: timerText(t), boss: b.id });
  }
  for (const [code, s] of Object.entries(data.seen)) {
    for (const p of s.points) add("seen", p, `seen${s.boss ? " isBoss" : ""}`, s.name || `NPC ${code}`, { kind: s.boss ? "Boss you have seen" : "Monster you have seen", more: `seen ${p.n} time${p.n === 1 ? "" : "s"} here` });
  }
  data.pins.forEach((p, i) => add("pin", p, "pin", p.name || "Pin", { kind: "Your pin", more: p.note || "", pin: i }));
  for (const p of data.imported) add("imported", p, "imported", p.name || "Marker", { kind: p.category || "Imported marker", more: p.note || "" });
  if (baseMap(liveMap) === mapId) {
    for (const p of live) if (p.kind === "party") add("me", p, "party", p.name || "Party member", { kind: "Party member" });
  }
  // You: where the game or your minimap last placed you.
  if (meShown) add("me", { x: meShown[0], y: meShown[1] }, "me", "You", { kind: "You", more: meFrom === "minimap" ? "found on your minimap" : "where the game last said you were" });
  if (calibrating) data.calib.refs.forEach((r, i) => out.push({ layer: "ref", x: r.world[0], y: r.world[1], cls: "ref", label: `${i + 1}. ${r.label}`, info: { kind: "Reference point" } }));
  return out;
}

function timerText(t) {
  if (!t) return "No timer reported yet";
  const now = Date.now() / 1000;
  if (t.state === "up") return t.upSince ? `Up for ${fmt(now - t.upSince)}` : "Up";
  if (t.nextSpawn) return t.nextSpawn > now ? `Spawns in ${fmt(t.nextSpawn - now)}` : "Due now";
  return "Down";
}
const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
};

function draw() {
  if (mapId === null) return;
  if (!image) computeGrid();
  const size = stageSize();
  const stage = $(".stage");
  stage.style.width = `${size.w}px`;
  stage.style.height = `${size.h}px`;
  applyView();
  const img = $(".mapImage");
  img.hidden = !image;
  if (image && img.src !== image.url) img.src = image.url;
  $(".grid").hidden = !!image;
  const banner = placing === "pin" ? "Click where the pin goes"
    : placing === "ref" ? `Click where ${refLabel()} is`
    : calibrating === "drag" ? "Drag the markers onto the map · Shift + scroll to size them"
    : "";
  $(".banner").hidden = !banner;
  $(".banner").textContent = banner;
  $(".emptyState").hidden = !!image || !!prefs.gridOk?.[mapId];
  $(".viewport").classList.toggle("aligning", calibrating === "drag");
  const box = $(".markers");
  const frag = document.createDocumentFragment();
  const inv = 1 / view.zoom;
  for (const mk of markersNow()) {
    const at = toStage(mk.x, mk.y);
    if (!at) continue;
    const el = document.createElement("div");
    el.className = `mk ${mk.cls}${selected && selected.x === mk.x && selected.y === mk.y && selected.label === mk.label ? " hit" : ""}`;
    el.style.left = `${at[0]}px`;
    el.style.top = `${at[1]}px`;
    el.style.transform = `scale(${inv})`;
    el.title = mk.label;
    if (mk.cls === "me") el.dataset.me = "";
    if (view.zoom >= (LABEL_ZOOM[mk.layer] ?? 0)) el.append(Object.assign(document.createElement("span"), { className: "lbl", textContent: mk.label }));
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      select(mk);
    });
    frag.append(el);
  }
  box.replaceChildren(frag);
  drawDots();
}

// The view on screen: the two pan layers moved by whole screen pixels (a
// layer moved by part of one is redrawn blurred), the picture and the
// markers zoomed within them. Each map's view is remembered.
let shownZoom = null;
let rememberTimer = 0;
function applyView() {
  const dpr = window.devicePixelRatio || 1;
  view.x = Math.round(view.x * dpr) / dpr;
  view.y = Math.round(view.y * dpr) / dpr;
  for (const el of document.querySelectorAll(".pan")) el.style.transform = `translate3d(${view.x}px, ${view.y}px, 0)`;
  if (shownZoom !== view.zoom) {
    shownZoom = view.zoom;
    $(".stage").style.transform = `scale(${view.zoom})`;
    $(".markers").style.transform = `scale(${view.zoom})`;
  }
  rememberSoon();
}

// The view and where you were on each map, kept a second after they settle:
// the map opens as it was left, and looks for you where you were.
function rememberSoon() {
  clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => {
    if (mapId === null) return;
    const r = vp.getBoundingClientRect();
    const middle = toWorld((r.width / 2 - view.x) / view.zoom, (r.height / 2 - view.y) / view.zoom);
    if (middle) prefs.views = { ...prefs.views, [mapId]: { x: Math.round(middle[0]), y: Math.round(middle[1]), zoom: view.zoom } };
    if (meShown) prefs.lastMe = { ...prefs.lastMe, [mapId]: meShown.map(Math.round) };
    store("prefs", prefs);
  }, 1000);
}

// The map as it was last left, else all of it.
function restoreView() {
  const v = prefs.views?.[mapId];
  if (!v || !Number.isFinite(v.zoom)) return fitView();
  view.zoom = v.zoom;
  if (!centerView(v.x, v.y)) return fitView();
  draw();
}

// Following you: close enough in to see where you are going (about 60
// world units a screen pixel), if the map is farther out than that.
function followZoom() {
  const T = calibrated() && transform();
  if (!T) return false;
  const want = 1 / (60 * Math.hypot(T[0], T[3]));
  if (view.zoom >= want * 0.8) return false;
  view.zoom = want;
  return true;
}

function fitView() {
  if (mapId === null) return;
  if (!image) computeGrid();
  const size = stageSize();
  const vp = $(".viewport").getBoundingClientRect();
  const zoom = Math.min(vp.width / size.w, vp.height / size.h) || 1;
  view = { zoom, x: (vp.width - size.w * zoom) / 2, y: (vp.height - size.h * zoom) / 2 };
  draw();
}

function centerOn(x, y) {
  if (centerView(x, y)) draw();
}

function centerView(x, y) {
  const at = toStage(x, y);
  if (!at) return false;
  const vp = $(".viewport").getBoundingClientRect();
  view.x = vp.width / 2 - at[0] * view.zoom;
  view.y = vp.height / 2 - at[1] * view.zoom;
  return true;
}

// You on the map. The game says where you are in a buff's record (once a
// second while one ticks on you, else when you get one), and your minimap
// (below) a few times a second. You are drawn a moment behind, at a steady
// pace from each place heard to the next, as online games show players, so
// you glide rather than jump. Each frame moves only you and the view; the
// rest is drawn now and then, and when you stop.
let meShown = null; // [x, y], where you are drawn
let meFrom = ""; // "minimap", or "" for the game's word
let trail = []; // [{ t, x, y }]: the places heard, oldest first
let trailFrame = 0;
let doubtful = null; // a minimap place too far to believe until the next agrees
const JUMP = 3000; // farther than this (a teleport), or after a pause: jump
const FASTEST = 4; // world units a millisecond: faster than this, a minimap place is doubted
const COAST = 100; // ms you keep moving past the last place heard

function moveMe(me, from = "") {
  const now = performance.now();
  const last = trail[trail.length - 1];
  if (last && last.x === me.x && last.y === me.y) return;
  // A minimap place much farther than you could have gone: another place
  // like yours, unless the next one says the same.
  if (from === "minimap" && last && now - last.t < 3000) {
    const far = Math.hypot(me.x - last.x, me.y - last.y);
    const agrees = doubtful && Math.hypot(me.x - doubtful.x, me.y - doubtful.y) < 600;
    if (far > 600 && far > FASTEST * (now - last.t) && !agrees) {
      doubtful = { x: me.x, y: me.y };
      return;
    }
  }
  doubtful = null;
  meFrom = from;
  if (!last || now - last.t > 3000 || Math.hypot(me.x - last.x, me.y - last.y) > JUMP) {
    trail = [{ t: now, x: me.x, y: me.y }];
    meShown = [me.x, me.y];
    if (follow) {
      followZoom();
      centerView(...meShown);
      draw();
    }
    rememberSoon();
    return;
  }
  // A minimap place is a few dozen units off either way: each is taken half
  // way from the last, so you do not wobble. The game's own are exact.
  const k = from === "minimap" ? 0.5 : 1;
  trail.push({ t: now, x: last.x + (me.x - last.x) * k, y: last.y + (me.y - last.y) * k });
  if (trail.length > 12) trail.shift();
  trailFrame ||= requestAnimationFrame(trailStep);
}

// How far behind you are drawn: a little more than the usual time between
// places, so the next one is nearly always in by the time it is needed.
function trailDelay() {
  const gaps = trail.slice(1).map((p, i) => p.t - trail[i].t).sort((a, b) => a - b);
  const usual = gaps.length ? gaps[gaps.length >> 1] : 300;
  return Math.min(1100, Math.max(120, usual * 1.5));
}

function trailStep(now) {
  trailFrame = 0;
  if (!trail.length) return;
  const at = now - trailDelay();
  const i = trail.findIndex((p) => p.t > at);
  const last = trail[trail.length - 1];
  const before = trail[trail.length - 2];
  // Past the last place heard: on at the same pace a little while, as the
  // next is most likely late; then you have stopped.
  const late = i < 0 ? at - last.t : 0;
  const stopped = i < 0 && (late > COAST || !before);
  if (i < 0 && !stopped) {
    const k = Math.min(late, COAST) / (last.t - before.t);
    meShown = [last.x + (last.x - before.x) * k, last.y + (last.y - before.y) * k];
  } else if (i < 0) meShown = [last.x, last.y];
  else if (i === 0) meShown = [trail[0].x, trail[0].y];
  else {
    const a = trail[i - 1];
    const b = trail[i];
    const k = (at - a.t) / (b.t - a.t);
    meShown = [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k];
  }
  if (follow && centerView(...meShown)) {
    applyView();
    drawDots();
  }
  const el = $(".markers [data-me]");
  const spot = el && toStage(...meShown);
  if (spot) Object.assign(el.style, { left: `${spot[0]}px`, top: `${spot[1]}px` });
  if (stopped) return void draw();
  trailFrame = requestAnimationFrame(trailStep);
}

// ── your minimap ────────────────────────────────────────────────────────────

// Following you by the game's minimap (minimap.js), a few times a second
// while this page is shown and you are on the map shown: the buff records
// place you now and then, this fills in between. It starts from where the
// game last said you were, so it needs that once (a skill or a dash).
let minimapFix = null; // { x, y, at }: where it last found you
let minimapMisses = 0;
let minimapTune = 0;
let minimapRunning = false;
let lastBuffMs = 0;
const MINIMAP_EVERY = 150;
const minimapCanvas = document.createElement("canvas");

function setMinimapState(text) {
  const el = $(".minimapState");
  el.textContent = text;
  el.hidden = !text;
}

// The picture is north up (a fit without a turn or mirror), as the minimap is.
function northUp() {
  const T = calibrated() && transform();
  return !!T && T[0] > 0 && T[4] > 0 && Math.abs(T[1]) < 0.02 * T[0] && Math.abs(T[3]) < 0.02 * T[4];
}

// The map picture's brightness over a world rect, as w × h pixels.
function mapGray(x0, y0, x1, y1, w, h) {
  const a = toStage(x0, y0);
  const b = toStage(x1, y1);
  const img = $(".mapImage");
  if (!a || !b || !img.naturalWidth) return null;
  Object.assign(minimapCanvas, { width: w, height: h });
  const g = minimapCanvas.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(img, a[0], a[1], b[0] - a[0], b[1] - a[1], 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return out;
}

async function pixelsOf(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const cv = Object.assign(document.createElement("canvas"), { width: img.naturalWidth, height: img.naturalHeight });
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, cv.width, cv.height);
}

// One look at the minimap; how long to wait before the next (ms).
// Where to look while lost, in turn: where you probably are (the game's last
// word, where you were when the map was last open, the middle of the map as
// shown), and between those, ring after ring of places around the first.
function lostPlace(n) {
  const r = vp.getBoundingClientRect();
  const middle = toWorld((r.width / 2 - view.x) / view.zoom, (r.height / 2 - view.y) / view.zoom);
  const seeds = [meShown, prefs.lastMe?.[mapId], middle].filter(Boolean);
  if (n % 2 === 0) return { near: seeds[(n / 2) % seeds.length], seed: true };
  // The ring places, outwards: 8 at the first ring, 16 at the second…
  let k = (n - 1) / 2;
  for (let ring = 1; ring <= 15; ring++) {
    if (k < 8 * ring) {
      const side = Math.floor(k / (2 * ring));
      const step = (k % (2 * ring)) - ring;
      const [dx, dy] = [[step, -ring], [ring, step], [-step, ring], [-ring, -step]][side];
      return { near: [seeds[0][0] + dx * LOST_STEP, seeds[0][1] + dy * LOST_STEP], seed: false };
    }
    k -= 8 * ring;
  }
  return { near: seeds[0], seed: true };
}
const LOST_STEP = 16000; // apart, each looked at 9000 around: they overlap
let lostTry = 0;
let candidate = null; // a place found while lost, until the next look agrees

// One look at the minimap; how long to wait before the next (ms).
async function minimapStep() {
  if (document.hidden) return MINIMAP_EVERY;
  // The map you are on, when the game has said (the meter reads its traffic).
  if (liveMap && baseMap(liveMap) !== mapId) {
    setMinimapState("Shows you on the map you are on");
    return 1000;
  }
  if (!northUp()) {
    setMinimapState("Needs this map's picture lined up, north up");
    return 2000;
  }
  const t0 = performance.now();
  let shot;
  try {
    shot = await a2.map.minimap();
  } catch (e) {
    setMinimapState(String(e?.message || e));
    return 3000;
  }
  const t1 = performance.now();
  const shown = minimapView(await pixelsOf(shot.png), shot.gameWidth, shot.gameHeight);
  const t2 = performance.now();
  if (!shown || shown.kept < 0.15) {
    setMinimapState("Can't see the minimap (top right of the game)");
    return 1000;
  }
  const now = performance.now();
  const fresh = minimapFix && now - minimapFix.at < 3000;
  const base = (prefs.minimapUnits || MINIMAP.units) / shot.gameHeight;
  let near;
  let radius = 3000;
  let scales = [1];
  if (fresh) near = [minimapFix.x, minimapFix.y];
  else if (candidate) {
    near = [candidate.x, candidate.y];
    scales = [candidate.k / base];
  } else {
    const place = lostPlace(lostTry++);
    near = place.near;
    radius = 9000;
    // Also at the minimap's usual scale (a scale learned wrong would never
    // find you), and now and then, where you probably are, at many (its
    // zoom may have changed).
    const usual = MINIMAP.units / shot.gameHeight / base;
    if (place.seed && lostTry % 6 === 1) scales = [1, 0.93, 1.07, 0.86, 1.16, 0.8, 1.25, 0.7, 1.4, 0.6, 1.66, 0.5, 2];
    else if (Math.abs(usual - 1) > 0.03) scales = [1, usual];
  }
  let best = null;
  for (const f of scales) {
    const m = minimapLocate(shown, { k: base * f, near, radius, grab: mapGray });
    if (m && (!best || m.score > best.score)) best = m;
    if (scales.length > 1) await new Promise((r) => setTimeout(r));
  }
  $(".trackMinimap").title = `Find you on the game's minimap. Last look: screen ${Math.round(t1 - t0)} ms, reading ${Math.round(t2 - t1)} ms, matching ${Math.round(performance.now() - t2)} ms`;
  // Found while lost: surer than while following, and again at the next look.
  const sure = fresh ? minimapSure(best) : minimapSure(best) && best.score >= 0.45 && best.score - best.second >= 0.18;
  if (!sure || (candidate && Math.hypot(best.x - candidate.x, best.y - candidate.y) > 1500)) {
    minimapMisses++;
    candidate = null;
    setMinimapState(fresh ? "Lost you on the minimap" : `Looking for you (${lostTry} places so far): use a skill, or move the map near where you are`);
    return MINIMAP_EVERY;
  }
  if (!fresh && !candidate) {
    candidate = { x: best.x, y: best.y, k: best.k };
    setMinimapState("Found you? Checking…");
    return 50;
  }
  candidate = null;
  lostTry = 0;
  minimapMisses = 0;
  let units = best.k * shot.gameHeight;
  // Now and then, its scale fine-tuned: a few percent off costs a third of
  // the score. A little bigger and a little smaller are tried where you
  // are, and the scale moves half way toward the better.
  if (fresh && ++minimapTune % 8 === 0) {
    for (const f of [0.96, 1.04]) {
      const m = minimapLocate(shown, { k: best.k * f, near: [best.x, best.y], radius: 600, grab: mapGray });
      if (m && m.score > best.score + 0.01) units = best.k * Math.sqrt(f) * shot.gameHeight;
    }
  }
  if (Math.abs(units - base * shot.gameHeight) > 1) {
    prefs.minimapUnits = Math.min(250000, Math.max(30000, units));
    store("prefs", prefs);
  }
  minimapFix = { x: best.x, y: best.y, at: now };
  setMinimapState("");
  moveMe(best, "minimap");
  return MINIMAP_EVERY;
}

async function minimapLoop() {
  if (minimapRunning) return;
  minimapRunning = true;
  while (prefs.minimap) {
    const started = performance.now();
    const wait = await minimapStep().catch((e) => (setMinimapState(String(e?.message || e)), 3000));
    // Busy at most half the time while following you, so the page stays
    // quick to use; a long search for you waits no more than half a second.
    const took = performance.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(Math.min(took, 500), wait - took)));
  }
  minimapRunning = false;
  minimapFix = null;
  setMinimapState("");
}

// ── the side panel ──────────────────────────────────────────────────────────

function renderMaps() {
  const ids = new Set(Object.keys(MAPS).map(Number));
  if (liveMap) ids.add(baseMap(liveMap));
  if (mapId !== null) ids.add(mapId);
  $(".mapPick").replaceChildren(
    ...[...ids].sort((a, b) => a - b).map((id) => Object.assign(document.createElement("option"), {
      value: id,
      textContent: `${mapName(id)}${baseMap(liveMap) === id ? " · you are here" : ""}`,
    })),
  );
  if (mapId !== null) $(".mapPick").value = String(mapId);
}

// The community maps of the region shown, opened in the browser (links in a
// plugin page go there). gaming.tools uses the game's own map ids.
const ATLAS_SLUGS = { 1010: "verteron", 1110: "altgard" };
function renderCommunity() {
  const links = [[`https://aion2.gaming.tools/map?map=${mapId}`, "gaming.tools"]];
  if (ATLAS_SLUGS[mapId]) links.push([`https://aion2atlas.app/map/${ATLAS_SLUGS[mapId]}/`, "Aion2 Atlas"]);
  links.push(["https://interactivemap.app/aion2/", "InteractiveMap"]);
  $(".communityLinks").innerHTML = links.map(([href, label]) => `<a class="btn small" href="${esc(href)}">${esc(label)} ↗</a>`).join("");
}

function renderSide() {
  renderMaps();
  renderCommunity();
  deleteButtons();
  const counts = {
    me: baseMap(liveMap) === mapId ? live.filter((p) => p.kind !== "npc").length : 0,
    kibelisk: (MAPS[mapId]?.kibelisks || []).length,
    boss: (MAPS[mapId]?.bosses || []).length,
    monster: (MAPS[mapId]?.monsters || []).length,
    seen: Object.values(data.seen).reduce((n, s) => n + s.points.length, 0),
    pin: data.pins.length,
    imported: data.imported.length,
  };
  $(".layers").replaceChildren(
    ...LAYERS.filter(([key]) => key !== "monster" || !pack?.kinds.pet).map(([key, label, color]) => {
      const l = document.createElement("label");
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!prefs.layers[key] });
      box.addEventListener("change", () => {
        prefs.layers[key] = box.checked;
        store("prefs", prefs);
        draw();
      });
      l.append(box, Object.assign(document.createElement("span"), { className: "sw" }), label, Object.assign(document.createElement("span"), { className: "count", textContent: counts[key] }));
      l.querySelector(".sw").style.background = color;
      return l;
    }),
  );
  renderBosses();
  renderPack();
  $(".imageNote").textContent = image
    ? data.calib.T
      ? `Your picture (${image.w}×${image.h}), lined up from ${data.calib.refs.length} places.`
      : data.calib.rough
        ? `Your picture (${image.w}×${image.h}), lined up by hand. Check that the blue squares sit on the teleport statues.`
        : "Your picture isn't lined up yet."
    : "No picture yet: the markers show on a plain grid, north up.";
  $(".calibrate").disabled = !image;
  $(".align").hidden = !calibrating;
  for (const b of document.querySelectorAll(".alignMode button")) b.setAttribute("aria-pressed", String(b.dataset.mode === calibrating));
  $(".dragTools").hidden = calibrating !== "drag";
  $(".calibration").hidden = calibrating !== "points";
  if (calibrating === "points") renderCalibration();
  else if (placing === "ref") placing = null;
  renderSelected();
}

function renderBosses() {
  let el = $(".bossList");
  if (!el) {
    el = Object.assign(document.createElement("div"), { className: "card bossList" });
    $(".packLayers").after(el);
  }
  const bosses = MAPS[mapId]?.bosses || [];
  if (!bosses.length) return void (el.hidden = true);
  el.hidden = false;
  el.innerHTML = `<b>Field bosses here</b><ul class="results">${bosses
    .map((b) => `<li data-boss="${b.id}">${esc(b.name)} <span class="tagline">${esc(timerText(bossTimers[b.id]))}${data.bossSpots[b.name] || packBosses[b.name] ? "" : " · spot not seen yet"}</span></li>`)
    .join("")}</ul>`;
  for (const li of el.querySelectorAll("[data-boss]")) {
    li.addEventListener("click", () => {
      const b = bosses.find((x) => String(x.id) === li.dataset.boss);
      const spot = b && (data.bossSpots[b.name] || packBosses[b.name]);
      if (spot) {
        centerOn(spot.x, spot.y);
        select({ x: spot.x, y: spot.y, label: b.name, info: { kind: "Field boss", more: timerText(bossTimers[b.id]) } });
      }
    });
  }
}

function select(mk) {
  selected = mk;
  renderSelected();
  draw();
}

function renderSelected() {
  const el = $(".selected");
  if (!selected) return void (el.hidden = true);
  el.hidden = false;
  const pin = selected.info?.pin;
  el.innerHTML = `<h4>${esc(selected.label)}</h4><div class="sub">${esc(selected.info?.kind || "")}</div>
    ${selected.info?.more ? `<div class="sub">${esc(selected.info.more)}</div>` : ""}
    <div class="sub">at ${Math.round(selected.x)}, ${Math.round(selected.y)}</div>
    ${pin !== undefined ? `<div class="row"><input type="text" class="pinName" value="${esc(selected.label)}" maxlength="40" /><button type="button" class="btn small danger delPin">Delete</button></div>
      <input type="text" class="pinNote" placeholder="Note" value="${esc(selected.info.more || "")}" maxlength="200" style="width:100%" />` : ""}`;
  if (pin !== undefined) {
    el.querySelector(".pinName").addEventListener("change", (e) => {
      data.pins[pin].name = e.target.value.trim();
      saveData(true);
      draw();
    });
    el.querySelector(".pinNote").addEventListener("change", (e) => {
      data.pins[pin].note = e.target.value.trim();
      saveData(true);
    });
    el.querySelector(".delPin").addEventListener("click", () => {
      data.pins.splice(pin, 1);
      selected = null;
      saveData(true);
      renderSide();
      draw();
    });
  }
}

// ── lining up the image ─────────────────────────────────────────────────────

function refOptions() {
  const opts = [];
  const me = baseMap(liveMap) === mapId && live.find((p) => p.kind === "me");
  if (me) opts.push({ label: "Where I am now", x: me.x, y: me.y });
  for (const k of [...(MAPS[mapId]?.kibelisks || [])].sort((a, b) => a.name.localeCompare(b.name))) opts.push({ label: k.name, x: k.x, y: k.y });
  for (const p of data.pins) opts.push({ label: `Pin: ${p.name || "pin"}`, x: p.x, y: p.y });
  return opts;
}
const refLabel = () => $(".refPick").selectedOptions[0]?.textContent || "it";

function renderCalibration() {
  const opts = refOptions();
  const pick = $(".refPick");
  const was = pick.value;
  pick.replaceChildren(...opts.map((o, i) => Object.assign(document.createElement("option"), { value: i, textContent: o.label })));
  if (was) pick.value = was;
  $(".refs").replaceChildren(
    ...data.calib.refs.map((r, i) => {
      const li = document.createElement("li");
      li.textContent = `${r.label} `;
      const x = Object.assign(document.createElement("button"), { type: "button", className: "btn small", textContent: "×" });
      x.addEventListener("click", () => {
        data.calib.refs.splice(i, 1);
        refit();
      });
      li.append(x);
      return li;
    }),
  );
  const fit = data.calib.refs.length >= 3 ? fitAffine(data.calib.refs) : null;
  $(".calError").textContent =
    data.calib.refs.length < 3
      ? `${3 - data.calib.refs.length} more to go`
      : fit
        ? `Off by at most ${fit.error.toFixed(1)} px${fit.error > 15 ? ": check the points" : ""}`
        : "These points are in a line: pick some further apart";
  placing = "ref";
  draw();
}

function refit() {
  data.calib.rough ||= null;
  const fit = data.calib.refs.length >= 3 ? fitAffine(data.calib.refs) : null;
  data.calib.T = fit ? fit.T : null;
  saveData(true);
  renderSide();
  draw();
}

// ── the map's mouse ─────────────────────────────────────────────────────────

const vp = $(".viewport");
let drag = null;
vp.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target.closest(".emptyState, .hud")) return;
  const r = data?.calib?.rough;
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, markers: calibrating === "drag" && r ? { tx: r.tx, ty: r.ty } : null };
  vp.classList.add("panning");
});
window.addEventListener("mousemove", (e) => {
  const r = vp.getBoundingClientRect();
  const px = (e.clientX - r.left - view.x) / view.zoom;
  const py = (e.clientY - r.top - view.y) / view.zoom;
  const w = toWorld(px, py);
  $(".coords").textContent = w && e.target.closest(".viewport") ? `${Math.round(w[0])}, ${Math.round(w[1])}` : "";
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.moved && drag.markers) {
    data.calib.rough.tx = drag.markers.tx + dx / view.zoom;
    data.calib.rough.ty = drag.markers.ty + dy / view.zoom;
    draw();
    return;
  }
  if (drag.moved) {
    if (follow) {
      follow = prefs.follow = false;
      store("prefs", prefs);
    }
    $(".follow").setAttribute("aria-pressed", "false");
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    applyView();
    dotsSoon();
  }
});
window.addEventListener("mouseup", (e) => {
  if (!drag) return;
  const clicked = !drag.moved;
  if (drag.markers && drag.moved) saveData();
  drag = null;
  vp.classList.remove("panning");
  if (!clicked || !e.target.closest(".viewport") || e.target.closest(".hud")) return;
  const r = vp.getBoundingClientRect();
  const px = (e.clientX - r.left - view.x) / view.zoom;
  const py = (e.clientY - r.top - view.y) / view.zoom;
  if (placing === "ref") {
    const o = refOptions()[Number($(".refPick").value)];
    if (!o) return;
    data.calib.refs.push({ world: [o.x, o.y], img: [px, py], label: o.label });
    // The next place on, for the next click.
    $(".refPick").selectedIndex = Math.min($(".refPick").options.length - 1, $(".refPick").selectedIndex + 1);
    refit();
    return;
  }
  if (placing === "pin") {
    const w = toWorld(px, py);
    placing = null;
    vp.classList.remove("placing");
    if (!w) return draw();
    data.pins.push({ x: w[0], y: w[1], name: `Pin ${data.pins.length + 1}`, note: "" });
    saveData(true);
    renderSide();
    select({ x: w[0], y: w[1], label: data.pins.at(-1).name, info: { kind: "Your pin", pin: data.pins.length - 1 } });
    return;
  }
  const dot = dotAt(e.clientX - r.left, e.clientY - r.top);
  select(dot ? dotSelection(dot) : null);
});
vp.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = vp.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  // Lining up: Shift + scroll sizes the markers around the pointer.
  if (calibrating === "drag" && e.shiftKey && data?.calib?.rough) {
    sizeMarkers(Math.exp(-(e.deltaY || e.deltaX) * 0.0012), (mx - view.x) / view.zoom, (my - view.y) / view.zoom);
    return;
  }
  const k = Math.exp(-e.deltaY * 0.0015);
  const zoom = Math.max(0.02, Math.min(8, view.zoom * k));
  view.x = mx - ((mx - view.x) * zoom) / view.zoom;
  view.y = my - ((my - view.y) * zoom) / view.zoom;
  view.zoom = zoom;
  draw();
}, { passive: false });
const zoomBy = (k) => {
  const r = vp.getBoundingClientRect();
  const z = Math.max(0.02, Math.min(8, view.zoom * k));
  view.x = r.width / 2 - ((r.width / 2 - view.x) * z) / view.zoom;
  view.y = r.height / 2 - ((r.height / 2 - view.y) * z) / view.zoom;
  view.zoom = z;
  draw();
};
$(".zoomIn").addEventListener("click", () => zoomBy(1.4));
$(".zoomOut").addEventListener("click", () => zoomBy(1 / 1.4));
$(".fit").addEventListener("click", fitView);
$(".follow").addEventListener("click", () => {
  follow = !follow;
  prefs.follow = follow;
  store("prefs", prefs);
  $(".follow").setAttribute("aria-pressed", String(follow));
  if (follow && meShown) {
    followZoom();
    centerOn(...meShown);
  }
});
$(".trackMinimap").addEventListener("click", () => {
  prefs.minimap = !prefs.minimap;
  store("prefs", prefs);
  $(".trackMinimap").setAttribute("aria-pressed", String(!!prefs.minimap));
  if (prefs.minimap) minimapLoop();
});
$(".search").addEventListener("input", draw);
$(".mapPick").addEventListener("change", () => openMap($(".mapPick").value));
// A new picture: the markers spread over it at once, to drag into place.
async function usePicture(url) {
  await loadImage(url);
  data.calib = { refs: [], T: null, rough: autoRough() };
  calibrating = "drag";
  saveData(true);
  renderSide();
  fitView();
}
for (const btn of document.querySelectorAll(".pickImage")) {
  btn.addEventListener("click", async () => {
    try {
      const url = await a2.map.pickImage(mapId);
      if (url) await usePicture(url);
    } catch (e) {
      $(".imageNote").textContent = String(e?.message || e);
    }
  });
}
async function takeFile(file) {
  if (!file || !/^image\/(png|jpe?g|webp)$/.test(file.type)) {
    $(".imageNote").textContent = "That isn't a PNG, JPEG or WebP picture.";
    return;
  }
  const url = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
  if (!url) return;
  try {
    const saved = await a2.map.saveImage(mapId, url);
    if (saved) await usePicture(saved);
  } catch (e) {
    $(".imageNote").textContent = String(e?.message || e);
  }
}
document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  e.preventDefault();
  takeFile(item.getAsFile());
});
vp.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  $(".dropHint").hidden = false;
});
vp.addEventListener("dragleave", (e) => {
  if (!vp.contains(e.relatedTarget)) $(".dropHint").hidden = true;
});
vp.addEventListener("drop", (e) => {
  e.preventDefault();
  $(".dropHint").hidden = true;
  takeFile(e.dataTransfer?.files?.[0]);
});
$(".gridOk").addEventListener("click", () => {
  prefs.gridOk = { ...(prefs.gridOk || {}), [mapId]: true };
  store("prefs", prefs);
  draw();
});

// Size the markers by `k` about stage point (px, py), so it stays put.
function sizeMarkers(k, px, py, axis = "both") {
  const r = data.calib.rough;
  const T = roughT(r);
  const w = invert(T, [px, py]);
  if (axis !== "y") r.scale *= k;
  if (axis === "y") r.aspect = (r.aspect || 1) * k;
  else if (axis === "x") r.aspect = (r.aspect || 1) / k;
  const [nx, ny] = apply(roughT(r), w);
  r.tx += px - nx;
  r.ty += py - ny;
  saveData();
  draw();
}

// The middle of the view, in stage pixels: buttons size the markers about it.
function viewMiddle() {
  const r = vp.getBoundingClientRect();
  return [(r.width / 2 - view.x) / view.zoom, (r.height / 2 - view.y) / view.zoom];
}

for (const b of document.querySelectorAll(".dragTools [data-t]")) {
  b.addEventListener("click", () => {
    if (!data.calib.rough) data.calib.rough = autoRough();
    const r = data.calib.rough;
    const [mx, my] = viewMiddle();
    switch (b.dataset.t) {
      case "bigger": return sizeMarkers(1.06, mx, my);
      case "smaller": return sizeMarkers(1 / 1.06, mx, my);
      case "taller": return sizeMarkers(1.04, mx, my, "y");
      case "shorter": return sizeMarkers(1 / 1.04, mx, my, "y");
      case "rotate": data.calib.rough = autoRough({ ...r, rot: ((r.rot || 0) + 1) % 4 }); break;
      case "mirror": data.calib.rough = autoRough({ ...r, flip: !r.flip }); break;
      case "reset": data.calib.rough = autoRough(); break;
    }
    saveData(true);
    draw();
  });
}
for (const b of document.querySelectorAll(".alignMode button")) {
  b.addEventListener("click", () => {
    calibrating = b.dataset.mode;
    if (calibrating === "drag" && !data.calib.rough) data.calib.rough = autoRough();
    renderSide();
    draw();
  });
}
$(".calibrate").addEventListener("click", () => {
  calibrating = calibrating ? null : data.calib.refs.length ? "points" : "drag";
  if (calibrating === "drag" && !data.calib.rough) data.calib.rough = autoRough();
  if (!calibrating) placing = null;
  renderSide();
  draw();
});
$(".doneAlign").addEventListener("click", () => {
  calibrating = null;
  saveData(true);
  renderSide();
  draw();
});
$(".clearRefs").addEventListener("click", () => {
  data.calib.refs = [];
  data.calib.T = null;
  refit();
});
$(".doneRefs").addEventListener("click", () => {
  calibrating = null;
  placing = null;
  renderSide();
  draw();
});
$(".addPin").addEventListener("click", () => {
  placing = "pin";
  vp.classList.add("placing");
  draw();
});
$(".clearSeen").addEventListener("click", () => {
  data.seen = {};
  data.bossSpots = {};
  saveData(true);
  renderSide();
  draw();
});

// Deleting this map's imported markers or pins: a second click, to be sure.
// renderSide keeps the buttons' counts (deleteButtons).
function twice(btn, label, run) {
  btn.addEventListener("click", () => {
    if (!btn.dataset.sure) {
      btn.dataset.sure = "1";
      btn.textContent = `${label}? Click again`;
      setTimeout(() => {
        delete btn.dataset.sure;
        deleteButtons();
      }, 4000);
      return;
    }
    delete btn.dataset.sure;
    run();
    saveData(true);
    renderSide();
    draw();
  });
}
twice($(".clearImported"), "Delete imported markers", () => ((data.imported = []), (selected = null)));
twice($(".clearPins"), "Delete pins", () => ((data.pins = []), (selected = null)));
function deleteButtons() {
  for (const [cls, label, n] of [[".clearImported", "Delete imported markers", data.imported.length], [".clearPins", "Delete pins", data.pins.length]]) {
    const btn = $(cls);
    if (btn.dataset.sure) continue;
    btn.textContent = n ? `${label} (${n.toLocaleString()})` : label;
    btn.disabled = !n;
  }
}

// ── importing markers ───────────────────────────────────────────────────────

function parseMarkers(text) {
  const t = text.trim();
  let rows = [];
  if (t.startsWith("[") || t.startsWith("{")) {
    const v = JSON.parse(t);
    rows = Array.isArray(v) ? v : Array.isArray(v.markers) ? v.markers : [];
  } else {
    const lines = t.split(/\r?\n/).filter(Boolean);
    const head = lines.shift().split(",").map((h) => h.trim().toLowerCase());
    rows = lines.map((line) => Object.fromEntries(line.split(",").map((v, i) => [head[i], v.trim()])));
  }
  return rows
    .map((r) => ({ map: Number(r.map ?? r.mapId), x: Number(r.x), y: Number(r.y), name: String(r.name ?? r.title ?? "").slice(0, 80), category: String(r.category ?? r.type ?? "").slice(0, 40), note: String(r.note ?? "").slice(0, 200) }))
    // A marker says what it is: rows with no name or kind but numbers are
    // some other file's numbers read as places (gaming.tools' files, before they
    // were known, put hundreds such in the map's middle).
    .filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && saysWhat(r));
}

// A name or kind that is a word, not a bare number ("6" is some file's index).
const saysWhat = (r) => [r.name, r.category].some((v) => v && !/^\d+$/.test(String(v).trim()));

// Those already imported so, gone (saved at once).
function dropBlankImports() {
  const kept = (data.imported || []).filter(saysWhat);
  if (kept.length === data.imported.length) return;
  data.imported = kept;
  saveData(true);
}
async function importFile(note) {
  try {
    const text = await a2.map.pickMarkers();
    if (!text) return;
    const t = text.trim();
    const kind = t.startsWith("[") ? packKind(JSON.parse(t)) : null;
    if (kind === "maps" || kind === "search") {
      note.textContent = `That's gaming.tools' ${kind === "maps" ? "list of maps" : "search index"}. The markers are in the file named after the map's number: ${mapId}.d.json for ${mapName(mapId)}.`;
      return;
    }
    if (kind === "map") return void (await takePack(packOf(JSON.parse(t)), note));
    const rows = parseMarkers(text);
    const here = rows.filter((r) => !r.map || baseMap(r.map) === mapId);
    data.imported = [...data.imported, ...here].slice(-5000);
    saveData(true);
    note.textContent = `${here.length} markers for ${mapName(mapId)}${rows.length > here.length ? ` (${rows.length - here.length} for other maps: open those and import again)` : ""}.`;
    renderSide();
    draw();
  } catch (e) {
    note.textContent = `Couldn't read it: ${e?.message || e}`;
  }
}
$(".importMarkers").addEventListener("click", () => importFile($(".importNote")));
$(".importPack").addEventListener("click", () => importFile($(".packNote")));

// ── the saved map file ──────────────────────────────────────────────────────

// Kept in two parts, each under the storage's 1 MB a key: the monsters, and the rest.
async function takePack(p, note) {
  const id = baseMap(p.map);
  if (!Number.isFinite(id) || !p.entries.length) throw new Error("there are no markers in it");
  const isMonster = (e) => e.t.some((t) => t.startsWith("monster-"));
  const monsters = p.entries.filter(isMonster);
  await a2.storage.set(`pack-${id}`, { saved: Date.now(), entries: p.entries.filter((e) => !isMonster(e)) });
  let left = "";
  try {
    await a2.storage.set(`pack-${id}-monsters`, { entries: monsters });
  } catch {
    // Too many to keep: the common ones go, pet soul monsters stay.
    const pets = new Set((MAPS[id]?.monsters || []).map((m) => m.npcId));
    await a2.storage.set(`pack-${id}-monsters`, { entries: monsters.filter((e) => pets.has(e.id) || !e.t.includes("monster-rank-normalmonster")) });
    left = " Common monsters were left out: too many to keep.";
  }
  const spots = p.entries.reduce((n, e) => n + e.xy.length / 2, 0);
  note.textContent = `${spots.toLocaleString()} spots for ${mapName(id)}, kept on this computer.${left}`;
  if (id !== mapId) await openMap(id);
  else {
    await loadPack();
    renderSide();
    draw();
  }
}

async function loadPack() {
  const id = mapId;
  const [rest, monsters] = await Promise.all([
    a2.storage.get(`pack-${id}`).catch(() => null),
    a2.storage.get(`pack-${id}-monsters`).catch(() => null),
  ]);
  if (id !== mapId) return;
  pack = null;
  packBosses = {};
  // One imported here comes first; else the build's own (local/packs.js).
  const own = typeof LOCAL_PACKS === "object" ? LOCAL_PACKS[id] : null;
  const built = !rest?.entries && !!own?.entries;
  if (!rest?.entries && !built) return;
  const pets = new Map((MAPS[id]?.monsters || []).map((m) => [m.npcId, m.pets]));
  // Copied: the layer keys added below stay off the build's own.
  const entries = built ? own.entries.map((e) => ({ ...e })) : [...rest.entries, ...(monsters?.entries || [])];
  for (const e of entries) {
    e.k = packLayerOf(e, pets);
    if (e.k === "pet") e.pets = pets.get(e.id);
    if (e.t.includes("boss") && e.n) packBosses[e.n] = { x: e.xy[0], y: e.xy[1] };
  }
  // Each layer's kinds (Asvata, Orichalcum, Hidden Cube…), most spots first.
  const kinds = {};
  for (const e of entries) {
    if (!e.k) continue;
    const m = (kinds[e.k] ||= new Map());
    m.set(e.n, (m.get(e.n) || 0) + e.xy.length / 2);
  }
  for (const k in kinds) kinds[k] = [...kinds[k]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  pack = { saved: built ? own.saved : rest.saved, entries, kinds, built };
}

// A layer's own setting, and each kind's: a kind follows its layer until it
// is set on its own (`prefs.packKind`, keyed "layer|name").
const packOn = (l) => prefs.pack?.[l.key] ?? l.on;
const kindKey = (k, n) => `${k}|${n}`;
const kindOn = (l, n) => prefs.packKind?.[kindKey(l.key, n)] ?? packOn(l);
const PACK_INDEX = new Map(PACK_LAYERS.map((l, i) => [l.key, i]));

// The file's spots, drawn on a canvas the size of the view: thousands of them
// stay quick. The canvas is the view's own, never moved or scaled, so its
// names stay sharp; it is drawn again whenever the view moves. `dotHits`:
// what was drawn, for clicks.
let dotHits = [];
let dotsFrame = 0;
const dotsSoon = () => (dotsFrame ||= requestAnimationFrame(() => ((dotsFrame = 0), drawDots())));
function drawDots() {
  const cv = $(".dots");
  const r = vp.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) Object.assign(cv, { width: w, height: h });
  cv.style.width = `${r.width}px`;
  cv.style.height = `${r.height}px`;
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  dotHits = [];
  if (!pack || (image && !calibrated())) return;
  const q = $(".search").value.trim().toLowerCase();
  // By layer, the first listed drawn last, on top.
  const byLayer = PACK_LAYERS.map(() => []);
  for (const e of pack.entries) {
    const i = PACK_INDEX.get(e.k);
    if (i === undefined || !kindOn(PACK_LAYERS[i], e.n) || (q && !e.n.toLowerCase().includes(q))) continue;
    for (let j = 0; j < e.xy.length; j += 2) {
      const at = toStage(e.xy[j], e.xy[j + 1]);
      if (!at) continue;
      const sx = view.x + at[0] * view.zoom;
      const sy = view.y + at[1] * view.zoom;
      if (sx < -40 || sy < -20 || sx > r.width + 40 || sy > r.height + 20) continue;
      byLayer[i].push({ sx, sy, e, l: PACK_LAYERS[i], x: e.xy[j], y: e.xy[j + 1] });
    }
  }
  const rad = view.zoom >= 2 ? 4.5 : view.zoom >= 0.8 ? 3.5 : 2.5;
  g.lineWidth = 1;
  g.strokeStyle = "rgba(0, 0, 0, 0.75)";
  for (let i = byLayer.length - 1; i >= 0; i--) {
    const l = PACK_LAYERS[i];
    for (const d of byLayer[i]) {
      dotHits.push(d);
      if (l.shape === "text") continue;
      g.fillStyle = l.color;
      g.beginPath();
      if (l.shape === "square") g.rect(d.sx - rad, d.sy - rad, rad * 2, rad * 2);
      else if (l.shape === "diamond") {
        const k = rad * 1.35;
        g.moveTo(d.sx, d.sy - k);
        g.lineTo(d.sx + k, d.sy);
        g.lineTo(d.sx, d.sy + k);
        g.lineTo(d.sx - k, d.sy);
        g.closePath();
      } else g.arc(d.sx, d.sy, l.shape === "ring" ? rad + 1 : rad, 0, Math.PI * 2);
      if (l.shape === "ring") {
        g.lineWidth = 3;
        g.stroke();
        g.lineWidth = 1.5;
        g.strokeStyle = l.color;
        g.stroke();
        g.lineWidth = 1;
        g.strokeStyle = "rgba(0, 0, 0, 0.75)";
      } else {
        g.fill();
        g.stroke();
      }
    }
  }
  g.textBaseline = "middle";
  g.lineJoin = "round";
  const text = (str, x, y, font, align) => {
    g.font = font;
    g.textAlign = align;
    g.lineWidth = 3;
    g.strokeStyle = "rgba(0, 0, 0, 0.85)";
    g.strokeText(str, x, y);
    g.fillStyle = "#fff";
    g.fillText(str, x, y);
  };
  const shapes = dotHits.filter((d) => d.l.shape !== "text");
  // Names once few enough are in view to read.
  if (shapes.length <= 160) for (const d of shapes) if (d.e.n) text(d.e.n, d.sx + rad + 4, d.sy, "11px 'Segoe UI', system-ui, sans-serif", "left");
  for (const d of dotHits) if (d.l.shape === "text") text(d.e.n, d.sx, d.sy, "600 12px 'Segoe UI', system-ui, sans-serif", "center");
  const sel = selected?.dot && dotHits.find((d) => d.x === selected.x && d.y === selected.y && d.e.n === selected.dot);
  if (sel) {
    g.lineWidth = 2;
    g.strokeStyle = "#fff";
    g.beginPath();
    g.arc(sel.sx, sel.sy, rad + 5, 0, Math.PI * 2);
    g.stroke();
  }
}

// The spot drawn nearest view point (x, y), within a few pixels.
function dotAt(x, y) {
  let best = null;
  let near = 8 * 8;
  for (const d of dotHits) {
    if (d.l.shape === "text") continue;
    const dd = (d.sx - x) ** 2 + (d.sy - y) ** 2;
    if (dd < near) [best, near] = [d, dd];
  }
  return best;
}

function dotSelection(d) {
  const n = d.e.xy.length / 2;
  const more = [
    d.e.pets?.length ? `Souls for ${d.e.pets.join(", ")}` : "",
    d.e.to ? `Leads to ${d.e.to}` : "",
    n > 1 ? `${n} spots on this map` : "",
  ].filter(Boolean).join(" · ");
  return { x: d.x, y: d.y, label: d.e.n || d.l.label, dot: d.e.n, info: { kind: `${d.l.label}${d.e.lv ? ` · level ${d.e.lv}` : ""}${pack.built ? "" : " · from your saved map file"}`, more } };
}

// The file's layers, grouped, each with how many spots it has here.
function renderPack() {
  $(".packFile").textContent = `${mapId}.d.json`;
  // Built in, its layers are the map's own: listed with the others, and
  // nothing to import.
  $(".community").hidden = !!pack?.built;
  const el = $(".packLayers");
  if (!pack) {
    el.hidden = true;
    return el.replaceChildren();
  }
  el.hidden = false;
  el.className = pack.built ? "packLayers" : "card packLayers";
  const counts = {};
  for (const e of pack.entries) if (e.k) counts[e.k] = (counts[e.k] || 0) + e.xy.length / 2;
  const head = document.createElement("div");
  head.className = "packHead";
  const when = pack.saved ? new Date(pack.saved).toLocaleDateString() : "";
  head.innerHTML = `<b>${pack.built ? "Built in from your saved map file" : "From your saved map file"}</b><span class="tagline">${esc(when)}</span>`;
  const remove = Object.assign(document.createElement("button"), { type: "button", className: "btn small danger", textContent: "Remove" });
  remove.addEventListener("click", async () => {
    // Twice, to be sure.
    if (remove.textContent === "Remove") return void (remove.textContent = "Remove it?");
    await Promise.all([a2.storage.set(`pack-${mapId}`, null), a2.storage.set(`pack-${mapId}-monsters`, null)]).catch(() => {});
    // The build's own copy, if there is one, shows again.
    await loadPack();
    renderSide();
    draw();
  });
  head.append(remove);
  const groups = [...new Set(PACK_LAYERS.map((l) => l.group))];
  const open = prefs.packOpen || { Collectables: true, Gathering: true, Monsters: true };
  el.replaceChildren(
    ...(pack.built ? [] : [head]),
    ...groups.map((group) => {
      const layers = PACK_LAYERS.filter((l) => l.group === group && counts[l.key]);
      const box = document.createElement("details");
      box.className = "packGroup";
      box.open = !!open[group];
      box.hidden = !layers.length;
      box.addEventListener("toggle", () => {
        prefs.packOpen = { ...open, [group]: box.open };
        store("prefs", prefs);
      });
      const kinds = (l) => pack.kinds[l.key] || [];
      const shown = (l) => kinds(l).filter(([n]) => kindOn(l, n)).length;
      const on = layers.filter((l) => shown(l)).length;
      box.append(Object.assign(document.createElement("summary"), { textContent: `${group} (${on} of ${layers.length})` }));
      const save = () => {
        store("prefs", prefs);
        renderPack();
        draw();
      };
      const openKinds = prefs.packKindsOpen || {};
      for (const l of layers) {
        const list = kinds(l);
        const n = shown(l);
        const row = document.createElement("div");
        row.className = "packLayer";
        const label = document.createElement("label");
        const check = Object.assign(document.createElement("input"), { type: "checkbox", checked: n === list.length, indeterminate: n > 0 && n < list.length });
        // The layer's box sets all its kinds at once.
        check.addEventListener("change", () => {
          prefs.pack = { ...(prefs.pack || {}), [l.key]: check.checked };
          prefs.packKind = Object.fromEntries(Object.entries(prefs.packKind || {}).filter(([k]) => !k.startsWith(`${l.key}|`)));
          save();
        });
        const sw = Object.assign(document.createElement("span"), { className: `sw ${l.shape || ""}` });
        sw.style.background = l.shape === "ring" || l.shape === "text" ? "transparent" : l.color;
        sw.style.borderColor = l.color;
        // A layer of one kind here says which ("Logs: Asvata").
        // Its name alone when it already says the layer ("Empyrean Trace: Altgard").
        const one = list.length === 1 ? list[0][0] : "";
        const only = !one || one === l.label ? l.label
          : one.toLowerCase().startsWith(l.label.split(" ")[0].toLowerCase()) ? one : `${l.label}: ${one}`;
        label.append(check, sw, only, Object.assign(document.createElement("span"), { className: "count", textContent: counts[l.key].toLocaleString() }));
        row.append(label);
        if (list.length > 1) {
          const more = Object.assign(document.createElement("button"), {
            type: "button",
            className: "kindsBtn",
            textContent: `${openKinds[l.key] ? "▾" : "▸"} ${list.length}`,
            title: `Choose which of the ${list.length} kinds to show`,
          });
          more.setAttribute("aria-expanded", String(!!openKinds[l.key]));
          more.addEventListener("click", () => {
            prefs.packKindsOpen = { ...openKinds, [l.key]: !openKinds[l.key] };
            store("prefs", prefs);
            renderPack();
          });
          row.append(more);
        }
        box.append(row);
        if (list.length > 1 && openKinds[l.key]) {
          const sub = document.createElement("div");
          sub.className = "packKinds";
          for (const [name, count] of list) {
            const kr = document.createElement("label");
            const kc = Object.assign(document.createElement("input"), { type: "checkbox", checked: kindOn(l, name) });
            kc.addEventListener("change", () => {
              prefs.packKind = { ...(prefs.packKind || {}), [kindKey(l.key, name)]: kc.checked };
              save();
            });
            kr.append(kc, name || l.label, Object.assign(document.createElement("span"), { className: "count", textContent: count.toLocaleString() }));
            sub.append(kr);
          }
          box.append(sub);
        }
      }
      return box;
    }),
  );
}

// ── the game ────────────────────────────────────────────────────────────────

// A monster seen: kept as the spots it was seen at, one per area.
function noteSeen(p) {
  if (!p.npc || mapId === null || baseMap(liveMap) !== mapId) return false;
  const key = String(p.npc);
  const s = (data.seen[key] ||= { name: p.name, boss: p.boss, points: [] });
  s.name ||= p.name;
  const near = s.points.find((q) => Math.hypot(q.x - p.x, q.y - p.y) < SAME_SPOT);
  if (near) {
    if (near.last === p.ms) return false;
    near.x = (near.x * near.n + p.x) / (near.n + 1);
    near.y = (near.y * near.n + p.y) / (near.n + 1);
    near.n += 1;
    near.last = p.ms;
  } else {
    if (s.points.length >= MAX_SPOTS) return false;
    s.points.push({ x: p.x, y: p.y, n: 1, last: p.ms });
  }
  // A field boss's spot, by its name.
  if (p.boss && (MAPS[mapId]?.bosses || []).some((b) => b.name === p.name)) data.bossSpots[p.name] = { x: p.x, y: p.y };
  const codes = Object.keys(data.seen);
  if (codes.length > MAX_SEEN) delete data.seen[codes[0]];
  return true;
}

let lastSide = 0;
a2.on("combat", (snap) => {
  const was = baseMap(liveMap);
  liveMap = snap.mapId || 0;
  live = snap.positions || [];
  if (mapId === null && liveMap) return void openMap(baseMap(liveMap));
  if (!data) return;
  let changed = false;
  for (const p of live) if (p.kind === "npc") changed = noteSeen(p) || changed;
  if (changed) saveData();
  const me = live.find((p) => p.kind === "me");
  if (me && baseMap(liveMap) === mapId) {
    // Each of the game's places once: the feed sends the last again each second.
    if (me.ms !== lastBuffMs) {
      lastBuffMs = me.ms;
      // Far from where the minimap had you: that was another place like it.
      if (minimapFix && Math.hypot(me.x - minimapFix.x, me.y - minimapFix.y) > 2500) minimapFix = null;
      moveMe(me);
    }
  } else if (liveMap && baseMap(liveMap) !== mapId) {
    meShown = null;
    trail = [];
  }
  draw();
  if (was !== baseMap(liveMap) || Date.now() - lastSide > 3000) {
    lastSide = Date.now();
    renderSide();
  }
});
a2.on("character", (c) => {
  const first = !character && c?.serverId;
  character = c;
  if (first) readTimers();
});
async function readTimers() {
  if (!character?.serverId) return;
  const t = await a2.bossTimers(character.serverId).catch(() => null);
  if (t?.bosses) bossTimers = t.bosses;
  renderBosses();
  draw();
}
a2.on("bossMap", (m) => {
  if (m?.bosses) Object.assign(bossTimers, m.bosses);
  renderBosses();
});
setInterval(readTimers, 60_000);
setInterval(() => {
  if (!$(".bossList")?.hidden) renderBosses();
}, 5000);
window.addEventListener("resize", () => draw());

(async () => {
  const stored = await a2.storage.get("prefs").catch(() => null);
  if (stored) prefs = { ...prefs, ...stored, layers: { ...prefs.layers, ...(stored.layers || {}) } };
  a2.ready();
  await openMap(prefs.map ?? 1010);
  follow = !!prefs.follow;
  $(".follow").setAttribute("aria-pressed", String(follow));
  $(".trackMinimap").setAttribute("aria-pressed", String(!!prefs.minimap));
  if (prefs.minimap) minimapLoop();
})();
