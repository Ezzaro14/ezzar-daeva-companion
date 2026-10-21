// One Combat Assist bar. The plugin's page sends what each icon is
// ({ items: [{ readyAt, endAt, ... }] }, times on this clock); this page
// draws it, and redraws the countdowns every frame.
const barEl = document.querySelector(".bar");
let state = { items: [] };
let locked = false;
let layoutKey = "";
let slots = [];

const fmt = (ms) => {
  const s = ms / 1000;
  if (s >= 60) return `${Math.ceil(s / 60)}m`;
  if (s >= 10) return String(Math.ceil(s));
  return s.toFixed(1);
};

function build() {
  const key = JSON.stringify([state.shape, state.dir, state.size, state.items.map((i) => i.key + (i.icons || [])[0])]);
  if (key === layoutKey) return;
  layoutKey = key;
  document.documentElement.style.setProperty("--size", `${state.size || 44}px`);
  barEl.className = `bar shape-${state.shape || "square"} ${state.dir || "row"}`;
  slots = state.items.map((item) => {
    const slot = document.createElement("div");
    slot.className = `slot ${item.kind}`;
    const icon = iconElement(item.icons, item.name);
    const sweep = document.createElement("div");
    sweep.className = "sweep";
    const time = document.createElement("div");
    time.className = "time";
    const stacks = document.createElement("div");
    stacks.className = "stacks";
    const mark = document.createElement("div");
    mark.className = "mark";
    if (state.shape === "bar") {
      const fill = document.createElement("div");
      fill.className = "fill";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = item.name || "";
      slot.append(fill, icon, name, time, stacks, mark);
      return { slot, fill, time, stacks, mark, sweep };
    }
    slot.append(icon, sweep, time, stacks, mark);
    return { slot, sweep, time, stacks, mark };
  });
  barEl.replaceChildren(...slots.map((s) => s.slot));
  reportArea();
}

function draw() {
  const now = Date.now();
  document.body.classList.toggle("hidden", !!state.hidden);
  state.items.forEach((item, i) => {
    const s = slots[i];
    if (!s) return;
    let frac = 0;
    let text = "";
    let ready = false;
    let dim = false;
    if (item.kind === "skill") {
      const left = item.readyAt ? item.readyAt - now : 0;
      if (left > 0 && item.cdMs) {
        frac = Math.min(1, left / item.cdMs);
        text = fmt(left);
      } else {
        ready = true;
      }
      s.mark.textContent = item.unknown ? "?" : item.shortened && left > 0 ? "▼" : "";
      s.mark.title = item.unknown ? "Cooldown not known yet" : item.shortened ? "Cooldown shortened" : "";
      s.stacks.textContent = "";
    } else {
      const left = item.endAt ? item.endAt - now : 0;
      if (!item.active || (item.endAt && left <= 0)) {
        dim = true;
      } else if (item.endAt && item.lengthMs) {
        frac = Math.max(0, Math.min(1, left / item.lengthMs));
        text = fmt(left);
      } else {
        frac = 1;
      }
      s.stacks.textContent = item.active && item.stacks > 1 ? String(item.stacks) : "";
      s.mark.textContent = "";
    }
    // Just ready: a small pop, once.
    if (item.kind === "skill" && ready && s.wasReady === false) {
      s.slot.classList.remove("ready-now");
      void s.slot.offsetWidth;
      s.slot.classList.add("ready-now");
    }
    s.wasReady = item.kind === "skill" ? ready : undefined;
    s.slot.classList.toggle("soon", item.kind === "skill" && !ready && frac > 0 && frac * (item.cdMs || 0) < 3000);
    s.slot.classList.toggle("ready", ready && item.kind === "skill");
    s.slot.classList.toggle("glow", ready && item.kind === "skill" && state.glow !== false && !item.unknown);
    s.slot.classList.toggle("cooling", item.kind === "skill" && !ready);
    s.slot.classList.toggle("dim", dim);
    // Only while on cooldown: a ready skill, or a buff not on, goes out of
    // sight but keeps its place, so the others never shift mid-fight.
    const gone = !!state.onlyCooling && (item.kind === "skill" ? ready : dim);
    if (s.gone !== gone) {
      s.gone = gone;
      s.slot.style.visibility = gone ? "hidden" : "";
    }
    s.time.textContent = state.text === false ? "" : text;
    if (s.fill) {
      // Bars: a skill's fill grows back as it cools down; a buff's shrinks.
      const w = item.kind === "skill" ? (ready ? 1 : 1 - frac) : dim ? 0 : frac;
      s.fill.style.width = `${(w * 100).toFixed(1)}%`;
    } else if (item.kind === "skill") {
      const deg = frac * 360;
      s.sweep.style.background = frac > 0
        ? `conic-gradient(var(--cool) ${deg.toFixed(1)}deg, rgba(255, 228, 165, 0.9) ${deg.toFixed(1)}deg ${(deg + 2.5).toFixed(1)}deg, transparent 0)`
        : "none";
    } else {
      s.sweep.style.background = "none";
      s.slot.style.setProperty("--left", `${(frac * 360).toFixed(1)}deg`);
    }
  });
  requestAnimationFrame(draw);
}

a2.on("widget", (d) => {
  if (!d || !Array.isArray(d.items)) return;
  state = d;
  build();
});
a2.on("locked", (on) => {
  locked = !!on;
  document.body.classList.toggle("locked", locked);
});

// Only the bar takes the mouse; around it clicks go to the game.
let lastArea = "";
function reportArea() {
  if (typeof a2.widget.area !== "function") return;
  const r = barEl.getBoundingClientRect();
  const area = state.hidden
    ? { x: 0, y: 0, width: 1, height: 1 }
    : { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height) };
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

// A press becomes a drag once the pointer moves; a double-click opens the panel.
let press = null;
let lastClick = 0;
barEl.addEventListener("mousedown", (e) => {
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
  } else {
    lastClick = now;
  }
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

requestAnimationFrame(draw);
a2.ready();
