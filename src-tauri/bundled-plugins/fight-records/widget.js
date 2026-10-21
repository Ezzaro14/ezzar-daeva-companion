// Fight Records' widgets: "train", the training run's clock with Start and
// Stop; "notice", a personal best.
const name = a2.widget.name;
const panel = document.querySelector(`.panel.${name}`);
panel.hidden = false;
let locked = false;

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

if (name === "train") {
  const go = panel.querySelector(".go");
  const len = panel.querySelector(".len");
  const clockEl = panel.querySelector(".clock");
  const dpsEl = panel.querySelector(".dps");
  let st = { state: "idle" };
  a2.on("widget", (d) => {
    st = d || st;
    go.textContent = st.state === "idle" ? "Start" : "Stop";
    go.classList.toggle("stop", st.state !== "idle");
    len.disabled = st.state !== "idle";
    if (st.state === "idle") len.value = String(Math.round((st.lengthMs || 60000) / 1000));
    panel.classList.toggle("live", st.state !== "idle");
    dpsEl.textContent = st.dps != null ? `${k(st.dps)} DPS` : st.state === "armed" ? "hit a dummy" : "– DPS";
  });
  // The clock runs between updates.
  setInterval(() => {
    const since = Date.now() - (st.at || Date.now());
    if (st.state === "running") clockEl.textContent = clock(st.left != null ? st.left - since : st.elapsed + since);
    else clockEl.textContent = clock(st.lengthMs || 0);
  }, 100);
  go.addEventListener("click", () => a2.widget.post(st.state === "idle" ? { start: true } : { stop: true }).catch(() => {}));
  len.addEventListener("change", () => a2.widget.post({ length: Number(len.value) }).catch(() => {}));
} else {
  const title = panel.querySelector(".title");
  const sub = panel.querySelector(".sub");
  let until = 0;
  a2.on("widget", (d) => {
    if (!d) return;
    panel.querySelector(".kick").textContent = (d.title || "Personal best").replace(/!$/, "");
    title.textContent = d.line || "";
    sub.textContent = d.detail || "";
    until = d.until || 0;
    document.body.classList.remove("off");
  });
  document.body.classList.add("off");
  setInterval(() => {
    if (until && Date.now() > until) {
      until = 0;
      document.body.classList.add("off");
    }
  }, 250);
}

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

let press = null;
let lastClick = 0;
panel.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || locked || e.target.closest("button, select")) return;
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
