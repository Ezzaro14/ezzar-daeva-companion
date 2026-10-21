// A pinned timer's icon (pins.js sends it what to show every second). It
// follows the pointer when dragged, unless the pins are locked; a
// double-click opens the plugin's window.
//
// In anchor mode the anchor's widget is the whole grid (anchor.js sends it
// { kind: "grid", cells, ... }): the anchor's grip in the corner the grid
// grows from, and each icon drawn in its place, the same way as a single one.
const single = document.querySelector(".pin");
let locked = false;
let gridBox = null;

// Two letters for the badge: the first of each of the first two words, or the
// first two of one word ("Shugo" is "SH", "Kaira the Watcher" is "KT").
const initials = (name) => {
  const words = String(name || "").split(/[\s·:,-]+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length > 1 ? [...words[0]][0] + [...words[words.length - 1]][0] : [...words[0]].slice(0, 2).join("");
  return letters.toUpperCase();
};

// An icon's parts, made like widget.html's own.
function makePin() {
  const pin = document.createElement("div");
  pin.className = "pin";
  pin.innerHTML = '<div class="badge"><img class="art" alt="" hidden /><span class="glyph"></span></div>'
    + '<div class="time"></div><div class="sub"></div><div class="name"></div>';
  return pin;
}

// Draw timer `d` in icon element `pin`.
function renderPin(pin, d) {
  const glyph = pin.querySelector(".glyph");
  const art = pin.querySelector(".art");
  const badge = pin.querySelector(".badge");
  const sub = pin.querySelector(".sub");
  // The game's icon when there is one, else the initials. Taken from the
  // page's own copy (widget.html), which on Linux is the image itself.
  const src = (d.icon && document.querySelector(`.icons img[data-icon="${d.icon}"]`)?.getAttribute("src")) || "";
  if (art.getAttribute("src") !== src) {
    if (src) art.setAttribute("src", src);
    else art.removeAttribute("src");
  }
  art.hidden = !src;
  glyph.hidden = !!src;
  glyph.textContent = d.glyph || initials(d.name);
  pin.querySelector(".time").textContent = d.countdown || "";
  sub.textContent = d.sub || "";
  // A world boss's HP: the ring drains from the top as it falls.
  const hasHp = typeof d.hp === "number";
  badge.classList.toggle("hasHp", hasHp);
  const hpColor = hasHp ? (d.hp > 50 ? "#5fe08a" : d.hp > 20 ? "#ffd54a" : "#ff5a4f") : "";
  if (hasHp) {
    badge.style.setProperty("--hp", `${d.hp}%`);
    badge.style.setProperty("--hp-color", hpColor);
  }
  // The HP in the ring's colour; "Enter" keeps its own.
  sub.style.color = hpColor;
  pin.querySelector(".name").textContent = d.showName ? d.name : "";
  pin.className = `pin ${d.kind || "event"}${d.running ? " running" : ""}${d.due ? " due" : ""} ${d.effect || "shake"}`;
  pin.title = d.tip || (pin.closest(".grid") && d.name) || "";
}

// The grid: the frame's size, the grip in its corner, and each icon in its
// place, filling from the grip's side.
function renderGrid(g) {
  single.hidden = true;
  if (!gridBox) {
    gridBox = document.createElement("div");
    gridBox.className = "grid";
    const grip = document.createElement("div");
    grip.className = "grip";
    grip.textContent = "⚓";
    gridBox.append(grip);
    document.body.append(gridBox);
  }
  gridBox.style.width = `${g.width}px`;
  gridBox.style.height = `${g.height}px`;
  const gripSize = Number(g.gripSize) || 40;
  const grip = gridBox.querySelector(".grip");
  grip.style.left = `${g.grip.x}px`;
  grip.style.top = `${g.grip.y}px`;
  grip.style.width = grip.style.height = `${gripSize - 4}px`;
  grip.title = g.label || "";
  // Placing it (the plugin's Settings open): the anchor, and every place
  // the grid can fill, outlined.
  gridBox.classList.toggle("setup", !!g.setup);
  const left = String(g.dir).startsWith("left");
  const up = String(g.dir).endsWith("up");
  const top = Number(g.top) || 0;
  const gapX = Number(g.gapX) || 0;
  const gapY = Number.isFinite(Number(g.gapY)) ? Number(g.gapY) : 4;
  // A place's left edge; the icon sits in it with half the column gap on
  // each side.
  const colX = (i) => {
    const col = i % g.cols;
    return left ? g.width - gripSize - (col + 1) * g.cellW : gripSize + col * g.cellW;
  };
  const cells = Array.isArray(g.cells) ? g.cells : [];
  const pins = [...gridBox.querySelectorAll(".pin")];
  while (pins.length < cells.length) {
    const pin = makePin();
    gridBox.append(pin);
    pins.push(pin);
  }
  for (const [i, pin] of pins.entries()) {
    const d = cells[i];
    pin.hidden = !d;
    if (d) renderPin(pin, d);
  }
  // Each row as tall as its tallest icon (a row with none, while placing,
  // as tall as a typical one), packed from the anchor's side, so a short
  // row leaves no gap. The outlines follow the same rows.
  const rows = g.setup ? g.rows : Math.ceil(cells.length / g.cols);
  const heights = Array.from({ length: rows }, () => 0);
  for (const [i, pin] of pins.entries()) {
    if (pin.hidden) continue;
    const row = Math.floor(i / g.cols);
    heights[row] = Math.max(heights[row], pin.offsetHeight + gapY);
  }
  const rowTop = [];
  let y = up ? g.height : top;
  for (let row = 0; row < rows; row++) {
    const h = heights[row] || g.cellH;
    heights[row] = h;
    if (up) y -= h;
    rowTop[row] = y;
    if (!up) y += h;
  }
  for (const [i, pin] of pins.entries()) {
    if (pin.hidden) continue;
    const row = Math.floor(i / g.cols);
    pin.style.left = `${colX(i) + gapX / 2}px`;
    pin.style.top = `${up ? rowTop[row] + heights[row] - gapY - pin.offsetHeight : rowTop[row]}px`;
  }
  // While placing: every place outlined.
  const places = g.setup ? g.cols * g.rows : 0;
  const ghosts = [...gridBox.querySelectorAll(".ghost")];
  while (ghosts.length < places) {
    const ghost = document.createElement("div");
    ghost.className = "ghost";
    gridBox.prepend(ghost);
    ghosts.push(ghost);
  }
  for (const [i, ghost] of ghosts.entries()) {
    ghost.hidden = i >= places;
    if (ghost.hidden) continue;
    const row = Math.floor(i / g.cols);
    // Each outline is the icon's own place, the gaps left between them.
    ghost.style.left = `${colX(i) + gapX / 2}px`;
    ghost.style.top = `${rowTop[row] + (up ? gapY : 0)}px`;
    ghost.style.width = `${g.cellW - gapX}px`;
    ghost.style.height = `${Math.max(heights[row] - gapY, 8)}px`;
  }
  document.title = g.label || "Event Timers";
}

a2.on("widget", (d) => {
  // The World Bosses list draws itself (bosslist-widget.js).
  if (!d || d.kind === "bosslist" || window.bossListWidget) return;
  if (d.kind === "grid") renderGrid(d);
  else {
    renderPin(single, d);
    document.title = d.name || "Event Timers";
  }
  reportArea();
});

// The drawn parts: only they take the mouse, so icons set close together
// don't catch each other's drags (meter 2.0.70 on, Linux; elsewhere a press
// beside them just does nothing). In the grid, the grip and the icons shown.
const SHOWN = ".setup > .grip, .pin:not([hidden]) .badge, .pin:not([hidden]) .time, .pin:not([hidden]) .sub, .pin:not([hidden]) .name";
let lastArea = "";
function reportArea() {
  if (typeof a2.widget.area !== "function" || window.bossListWidget) return;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const el of document.querySelectorAll(SHOWN)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // The badge's ring and glow reach a little past it.
    const pad = el.classList.contains("badge") ? 4 : 0;
    left = Math.min(left, r.left - pad);
    top = Math.min(top, r.top - pad);
    right = Math.max(right, r.right + pad);
    bottom = Math.max(bottom, r.bottom + pad);
  }
  // Nothing drawn (an empty grid, its anchor hidden): a point, so the frame's
  // empty space doesn't keep clicks from the game.
  if (!(right > left && bottom > top)) {
    left = 0; top = 0; right = 1; bottom = 1;
  }
  const area = { x: Math.max(0, Math.floor(left)), y: Math.max(0, Math.floor(top)), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
  const key = JSON.stringify(area);
  if (key === lastArea) return;
  lastArea = key;
  a2.widget.area(area).catch(() => {});
}
addEventListener("resize", () => {
  lastArea = "";
  reportArea();
});
a2.on("locked", (on) => {
  locked = !!on;
  document.body.classList.toggle("locked", locked);
});

// A press becomes a drag only once the pointer moves: a window drag starts
// at once took the mouse (Windows), so the release never reached the page
// and a double-click never happened. Two clicks within DOUBLE_MS open the
// plugin's window.
const DRAG_PX = 4;
const DOUBLE_MS = 400;
let press = null;
let lastClick = 0;
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || locked || !(e.target instanceof Element) || !e.target.closest(SHOWN)) return;
  e.preventDefault();
  press = { x: e.screenX, y: e.screenY };
});
document.addEventListener("mousemove", (e) => {
  if (!press) return;
  if (!(e.buttons & 1)) {
    press = null;
    return;
  }
  if (Math.abs(e.screenX - press.x) + Math.abs(e.screenY - press.y) >= DRAG_PX) {
    press = null;
    lastClick = 0;
    a2.widget.drag().catch(() => {});
  }
});
document.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !press) return;
  press = null;
  const now = Date.now();
  if (now - lastClick <= DOUBLE_MS) {
    lastClick = 0;
    a2.widget.post({ open: true }).catch(() => {});
  } else {
    lastClick = now;
  }
});
// A right-click stops its alert's sound (unlocked: a locked icon lets clicks
// through to the game).
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  a2.widget.post({ mute: true }).catch(() => {});
});

a2.ready();
