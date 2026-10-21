// The ping widget: what the plugin's page sends it ({ ms, state, scale }),
// dragged by the pill unless locked; a double-click opens the settings.
const pill = document.querySelector(".pill");
const msEl = document.querySelector(".ms");
let locked = false;

a2.on("widget", (d) => {
  if (!d) return;
  pill.dataset.state = d.state || "none";
  msEl.textContent = typeof d.ms === "number" ? `${d.ms} ms` : "– ms";
  if (d.scale) document.documentElement.style.setProperty("--scale", String(d.scale));
  pill.classList.toggle("bare", d.background === false);
  pill.classList.toggle("noBars", d.bars === false);
  reportArea();
});
a2.on("locked", (on) => {
  locked = !!on;
  document.body.classList.toggle("locked", locked);
});

// Only the pill takes the mouse: clicks beside it go through to the game
// (meter 2.0.70 on, Linux).
let lastArea = "";
function reportArea() {
  if (typeof a2.widget.area !== "function") return;
  const r = pill.getBoundingClientRect();
  const area = { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  const key = JSON.stringify(area);
  if (key === lastArea) return;
  lastArea = key;
  a2.widget.area(area).catch(() => {});
}
addEventListener("resize", () => {
  lastArea = "";
  reportArea();
});

// A press becomes a drag once the pointer moves, so a double-click still
// reaches the page (as Event Timers' icons do).
const DRAG_PX = 4;
const DOUBLE_MS = 400;
let press = null;
let lastClick = 0;
pill.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || locked) return;
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
document.addEventListener("contextmenu", (e) => e.preventDefault());

reportArea();
a2.ready();
