// A Combat Alerts notice: "loc" (loss of control, with the time left) or
// "debuff" (a debuff on several party members). Hidden while off, but kept
// visible while unlocked so it can be placed.
const name = a2.widget.name;
document.body.classList.add(name);
const notice = document.querySelector(".notice");
const slot = document.querySelector(".slot");
const label = document.querySelector(".label");
const detail = document.querySelector(".detail");
const fill = document.querySelector(".fill");
const kicker = document.querySelector(".kicker");
const big = document.querySelector(".big");
const setFill = (f) => fill.parentElement.style.setProperty("--w-fill", String(Math.max(0, Math.min(1, f))));
let state = { active: false };
let locked = false;
let iconKey = "";

function show(d) {
  if (d && "placing" in d) {
    document.body.classList.toggle("placing", !!d.placing);
    reportArea();
    return;
  }
  state = d || { active: false };
  document.body.classList.toggle("off", !state.active);
  reportArea();
  if (!state.active) return;
  if (state.scale) document.documentElement.style.setProperty("--scale", String(state.scale));
  const key = JSON.stringify(state.icons || []) + state.name;
  if (key !== iconKey) {
    iconKey = key;
    slot.replaceChildren(iconElement(state.icons, state.name || state.label));
  }
  if (name === "loc") {
    kicker.textContent = "Loss of control";
    label.textContent = state.label || "";
    detail.textContent = state.name && state.name !== state.label ? state.name : "";
  } else {
    kicker.textContent = "Party debuff · cleanse";
    label.textContent = state.name || "";
    detail.textContent = `on ${state.count} of ${state.of} party members`;
    big.textContent = `${state.count}/${state.of}`;
  }
}

function draw() {
  if (state.active && name === "loc") {
    const left = state.endAt ? state.endAt - Date.now() : null;
    if (left !== null && left <= 0) {
      document.body.classList.add("off");
    } else {
      big.textContent = left === null ? "" : `${(left / 1000).toFixed(1)}s`;
      setFill(left !== null && state.lengthMs ? left / state.lengthMs : 1);
    }
  } else if (state.active && name === "debuff") {
    const left = state.until ? state.until - Date.now() : 0;
    setFill(left / (state.holdMs || 6000));
  }
  requestAnimationFrame(draw);
}

a2.on("widget", show);
a2.on("locked", (on) => {
  locked = !!on;
  document.body.classList.toggle("locked", locked);
  reportArea();
});

let lastArea = "";
function reportArea() {
  if (typeof a2.widget.area !== "function") return;
  const r = notice.getBoundingClientRect();
  // Out of sight, it takes no clicks.
  const unseen = document.body.classList.contains("off") && !document.body.classList.contains("placing");
  const area = locked || unseen ? { x: 0, y: 0, width: 1, height: 1 } : { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
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
notice.addEventListener("mousedown", (e) => {
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

slot.replaceChildren(iconElement([], name === "loc" ? "Stunned" : "Heal Block"));
kicker.textContent = name === "loc" ? "Loss of control" : "Party debuff";
label.textContent = name === "loc" ? "Stunned" : "Heal Block";
detail.textContent = "Shows here when it happens";
big.textContent = name === "loc" ? "2.4s" : "3/5";
setFill(0.6);
reportArea();
requestAnimationFrame(draw);
a2.ready();
