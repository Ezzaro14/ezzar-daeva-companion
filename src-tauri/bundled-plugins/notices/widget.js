// The notices popup: up to three at a time, newest on top, each gone after
// `hold` ms; one with an id is updated in place by the next of that id, and
// one kept (`keep`) stays until then. Only the popups (or, while placing, the
// outline) take the mouse.
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

// Fade a notice out and drop it.
function fade(el) {
  clearTimeout(el._timer);
  el.classList.add("out");
  setTimeout(() => {
    el.remove();
    reportArea();
  }, 300);
}

// Its countdown, from the start: none for a kept one.
function arm(el, keep) {
  clearTimeout(el._timer);
  el.classList.toggle("kept", keep);
  const old = el.querySelector(".bar");
  const bar = document.createElement("div");
  bar.className = "bar";
  if (keep) {
    bar.style.animation = "none";
  } else {
    bar.style.animationDuration = `${config.hold}ms`;
    el._timer = setTimeout(() => fade(el), config.hold);
  }
  if (old) old.replaceWith(bar);
  else el.append(bar);
}

const byId = (id) => [...stack.children].find((c) => c.dataset.id === id && !c.classList.contains("out"));

function add(n) {
  let el = n.id ? byId(n.id) : null;
  if (!el) {
    el = document.createElement("div");
    el.append(Object.assign(document.createElement("div"), { className: "title w-kicker" }));
    el.append(Object.assign(document.createElement("div"), { className: "text" }));
    if (n.id) el.dataset.id = n.id;
    stack.prepend(el);
  }
  el.className = `notice w-panel w-edge ${toneOf(n)}`;
  el.querySelector(".title").textContent = n.title || "";
  el.querySelector(".text").textContent = n.text || "";
  arm(el, !!n.keep);
  // Over three: the oldest that isn't kept goes first.
  while (stack.children.length > MAX) {
    const timed = [...stack.children].reverse().find((c) => !c.classList.contains("kept"));
    (timed || stack.lastElementChild).remove();
  }
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
  if (d.dismiss) {
    const el = byId(d.dismiss);
    if (el) fade(el);
  }
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
