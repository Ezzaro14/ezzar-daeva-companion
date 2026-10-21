// The PvP widget: the session's numbers and its opponents, as the plugin's
// page sends them; dragged by its panel unless locked.
const panel = document.querySelector(".panel");
const rowsEl = document.querySelector(".rows");
const idle = document.querySelector(".idle");
const timeEl = document.querySelector(".time");
const kdEl = document.querySelector(".kd");
const burstEl = document.querySelector(".burst");
let locked = false;

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

a2.on("widget", (d) => {
  if (!d) return;
  panel.classList.toggle("active", !!d.active);
  timeEl.textContent = d.since ? clock((d.active ? d.now : d.last) - d.since) : "";
  kdEl.textContent = `${d.kills} K · ${d.deaths} D`;
  burstEl.textContent = d.burst ? `burst ${k(d.burst)}` : "";
  const max = Math.max(1, ...d.rows.map((r) => Math.max(r.dealt, r.taken)));
  idle.hidden = d.rows.length > 0;
  rowsEl.replaceChildren(
    ...d.rows.map((r) => {
      const li = document.createElement("li");
      li.className = r.killed ? "killed" : r.down ? "down" : "";
      const icon = document.createElement("span");
      icon.className = "cls";
      if (r.icon) icon.style.backgroundImage = `url("${r.icon}")`;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const hp = document.createElement("span");
      hp.className = "hp";
      hp.textContent = r.killed ? "defeated" : typeof r.hp === "number" ? `${k(r.hp)} HP` : "";
      const bars = document.createElement("span");
      bars.className = "bars";
      bars.innerHTML = `<i class="d" style="width:${((r.dealt / max) * 100).toFixed(0)}%"></i><i class="t" style="width:${((r.taken / max) * 100).toFixed(0)}%"></i>`;
      const nums = document.createElement("span");
      nums.className = "nums";
      nums.innerHTML = `<b class="d">${k(r.dealt)}</b> <b class="t">${k(r.taken)}</b>`;
      li.append(icon, name, hp, nums, bars);
      return li;
    }),
  );
});
a2.on("locked", (on) => {
  locked = !!on;
  document.body.classList.toggle("locked", locked);
});

let lastArea = "";
function reportArea() {
  if (typeof a2.widget.area !== "function") return;
  const r = panel.getBoundingClientRect();
  const area = { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  const key = JSON.stringify(area);
  if (key === lastArea) return;
  lastArea = key;
  a2.widget.area(area).catch(() => {});
}
addEventListener("resize", () => {
  lastArea = "";
  reportArea();
});
setInterval(reportArea, 1000);

let press = null;
let lastClick = 0;
panel.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || locked) return;
  e.preventDefault();
  press = { x: e.screenX, y: e.screenY };
});
document.addEventListener("mousemove", (e) => {
  if (!press) return;
  if (!(e.buttons & 1)) return void (press = null);
  if (Math.abs(e.screenX - press.x) + Math.abs(e.screenY - press.y) >= 4) {
    press = null;
    lastClick = 0;
    a2.widget.drag().catch(() => {});
  }
});
document.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || !press) return;
  press = null;
  const now = Date.now();
  if (now - lastClick <= 400) {
    lastClick = 0;
    a2.widget.post({ open: true }).catch(() => {});
  } else lastClick = now;
});
document.addEventListener("contextmenu", (e) => e.preventDefault());
reportArea();
a2.ready();
