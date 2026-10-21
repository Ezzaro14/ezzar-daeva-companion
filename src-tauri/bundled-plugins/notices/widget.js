// The notices popup: up to three at a time, newest on top, each gone after
// `hold` ms. Only the popups (or, while placing, the outline) take the mouse.
const stack = document.querySelector(".stack");
const placeholder = document.querySelector(".placeholder");
let config = { hold: 8000, scale: 1, placing: false };
let locked = false;
const MAX = 3;

// A colour by what it is about: bosses and rifts gold, warnings amber,
// records green, the rest blue.
function toneOf(n) {
  const t = `${n.title || ""} ${n.text || ""}`.toLowerCase();
  if (/boss|gartua|rift|siege|invasion|spawn/.test(t)) return "is-gold";
  if (/personal best|record|new best/.test(t)) return "is-good";
  if (/warning|stun|debuff|died|death|lost/.test(t)) return "is-warn";
  return "is-info";
}

function add(n) {
  const el = document.createElement("div");
  el.className = `notice w-panel w-edge ${toneOf(n)}`;
  el.append(Object.assign(document.createElement("div"), { className: "title w-kicker", textContent: n.title || "" }));
  el.append(Object.assign(document.createElement("div"), { className: "text", textContent: n.text || "" }));
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.style.animationDuration = `${config.hold}ms`;
  el.append(bar);
  stack.prepend(el);
  while (stack.children.length > MAX) stack.lastElementChild.remove();
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => {
      el.remove();
      reportArea();
    }, 300);
  }, config.hold);
  reportArea();
}

a2.on("widget", (d) => {
  if (!d) return;
  if (d.config) {
    config = { ...config, ...d.config };
    document.documentElement.style.setProperty("--scale", String(config.scale));
    placeholder.hidden = !config.placing;
    reportArea();
  }
  if (d.notice) add(d.notice);
});
a2.on("locked", (on) => {
  locked = !!on;
  document.body.classList.toggle("locked", locked);
  reportArea();
});

let lastArea = "";
function reportArea() {
  if (typeof a2.widget.area !== "function") return;
  const target = !placeholder.hidden ? placeholder : stack.children.length ? stack : null;
  let area = { x: 0, y: 0, width: 1, height: 1 };
  if (target && !locked) {
    const r = target.getBoundingClientRect();
    area = { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  }
  const key = JSON.stringify(area);
  if (key === lastArea) return;
  lastArea = key;
  a2.widget.area(area).catch(() => {});
}

let press = null;
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || locked) return;
  e.preventDefault();
  press = { x: e.screenX, y: e.screenY };
});
document.addEventListener("mousemove", (e) => {
  if (!press) return;
  if (!(e.buttons & 1)) return void (press = null);
  if (Math.abs(e.screenX - press.x) + Math.abs(e.screenY - press.y) >= 4) {
    press = null;
    a2.widget.drag().catch(() => {});
  }
});
document.addEventListener("mouseup", () => (press = null));
document.addEventListener("contextmenu", (e) => e.preventDefault());
reportArea();
a2.ready();
