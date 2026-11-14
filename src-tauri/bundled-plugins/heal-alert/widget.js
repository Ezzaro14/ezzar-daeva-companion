// Heal Alert over the game (Ezzar's Daeva Companion): what the plugin's page
// sends ({ banner, members: [{ n, pct, state }], bars }), dragged when
// unlocked; a double-click opens the page. Only the panel takes the mouse.
const box = document.querySelector(".box");
const bannerEl = document.querySelector(".banner");
const list = document.querySelector(".members");
let locked = false;

a2.on("widget", (d) => {
  if (!d) return;
  const members = Array.isArray(d.members) ? d.members : [];
  bannerEl.hidden = !d.banner;
  bannerEl.textContent = d.banner || "";
  list.hidden = !d.bars || !members.length;
  while (list.children.length < members.length) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="n"></span><span class="bar"><span class="fill"></span></span><span class="pct"></span>';
    list.append(li);
  }
  while (list.children.length > members.length) list.lastChild.remove();
  members.forEach((m, i) => {
    const li = list.children[i];
    li.className = m.state || "";
    li.querySelector(".n").textContent = m.n;
    li.querySelector(".fill").style.width = `${Math.max(0, Math.min(100, m.pct))}%`;
    li.querySelector(".pct").textContent = m.state === "down" ? "down" : `${Math.round(m.pct)}%`;
  });
  box.hidden = bannerEl.hidden && list.hidden;
  reportArea();
});
a2.on("locked", (on) => {
  locked = !!on;
  document.body.classList.toggle("locked", locked);
});

let lastArea = "";
function reportArea() {
  if (typeof a2.widget.area !== "function") return;
  const r = box.hidden ? { left: 0, top: 0, width: 0, height: 0 } : box.getBoundingClientRect();
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
// reaches the page.
const DRAG_PX = 4;
const DOUBLE_MS = 400;
let press = null;
let lastClick = 0;
box.addEventListener("mousedown", (e) => {
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
