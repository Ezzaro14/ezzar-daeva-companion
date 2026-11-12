import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// The overlay (overlay.js) is the meter's page: the meter and every plugin's
// widgets over the game's screen. Where the window takes the mouse is what it
// tells the backend (overlay_input); everywhere else clicks reach the game.
const source = readFileSync(new URL("../public/src/js/overlay.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Just enough of a DOM for overlay.js: elements with classes, styles,
// children, listeners and a box each.
function element(tag, rect = null) {
  const classes = new Set();
  const listeners = new Map();
  const el = {
    tag,
    children: [],
    style: {},
    attributes: {},
    rect,
    textContent: "",
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
    },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    get className() { return [...classes].join(" "); },
    append: (...kids) => el.children.push(...kids),
    remove() {},
    setAttribute: (k, v) => { el.attributes[k] = v; },
    addEventListener: (name, fn) => listeners.set(name, [...(listeners.get(name) || []), fn]),
    removeEventListener() {},
    emit: (name, event) => (listeners.get(name) || []).forEach((fn) => fn(event)),
    setPointerCapture() {},
    getBoundingClientRect: () => {
      const r = el.rect || { left: 0, top: 0, width: 0, height: 0 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
    },
    matches: (selector) => selector.split(",").some((s) => classes.has(s.trim().replace(/^\./, ""))),
    get offsetWidth() { return el.rect?.width || 0; },
    get offsetHeight() { return el.rect?.height || 0; },
  };
  return el;
}

function setup() {
  const calls = [];
  const frames = [];
  const listeners = new Map();
  const headerBtns = element("div", { left: 300, top: 104, width: 70, height: 22 });
  const bossIcon = element("div", { left: 12, top: 104, width: 40, height: 22 });
  const meter = element("div", { left: 10, top: 100, width: 380, height: 240 });
  meter.className = "meter";
  meter.querySelector = (s) => (s === ".headerBtns" ? headerBtns : s === ".bossIcon" ? bossIcon : null);
  const container = element("div");
  container.className = "container";
  container.querySelector = (s) => (s === ":scope > .meter" ? meter : null);
  container.querySelectorAll = () => [];
  const card = element("div", { left: 800, top: 400, width: 360, height: 300 });
  let cardOpen = false;
  const html = element("html");
  const body = element("body");
  const document = {
    documentElement: html,
    body,
    activeElement: null,
    createElement: (tag) => element(tag),
    querySelector: (s) => (s === ".container" ? container : null),
    querySelectorAll: (s) => (s.includes("isOpen") && cardOpen ? [card] : []),
  };
  const winListeners = new Map();
  const window = {
    A2_VIEW: "main",
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    addEventListener: (name, fn) => winListeners.set(name, [...(winListeners.get(name) || []), fn]),
    removeEventListener: (name, fn) => winListeners.set(name, (winListeners.get(name) || []).filter((f) => f !== fn)),
    emit: (name, event) => [...(winListeners.get(name) || [])].forEach((fn) => fn(event)),
    __TAURI__: {
      core: {
        convertFileSrc: () => "a2plugin://localhost/",
        invoke: (command, args) => {
          calls.push({ command, args });
          if (command === "overlay_hello") {
            return Promise.resolve({
              state: { editing: false, hidden: false, hiddenPlugins: [], locked: {}, screenshot: false, meter: { hidden: false, locked: true, clickThrough: false } },
              meter: { x: 0.005, y: 0.1, opacity: 1 },
              widgets: [],
            });
          }
          return Promise.resolve();
        },
      },
      webviewWindow: { getCurrentWebviewWindow: () => ({ listen: (name, fn) => listeners.set(name, fn) }) },
    },
  };
  const context = vm.createContext({
    window, document, console, Number, Math, JSON, Object, String, Array,
    requestAnimationFrame: (fn) => frames.push(fn),
    setTimeout: () => 0, clearTimeout() {},
  });
  vm.runInContext(source, context);
  const flush = () => { while (frames.length) frames.shift()(); };
  const say = (op) => listeners.get("overlay")({ payload: op });
  // Plain values: arrays made in the page's context are of another realm.
  const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const lastInput = () => plain(calls.filter((c) => c.command === "overlay_input").at(-1)?.args);
  const state = (meterState, more = {}) => say({
    op: "state", editing: false, hidden: false, hiddenPlugins: [], locked: {}, screenshot: false,
    meter: { hidden: false, locked: true, clickThrough: false, ...meterState }, ...more,
  });
  return { calls, flush, say, state, lastInput, meter, container, html, body, window, setCard: (open) => { cardOpen = open; } };
}

const rectOf = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };

test("the meter takes the mouse over itself only, locked or not", async () => {
  const o = setup();
  await tick();
  o.flush();
  assert.deepEqual(o.lastInput().rects, [rectOf(o.meter)]);
  assert.equal(o.lastInput().all, false);
  assert.deepEqual(o.lastInput().meter, rectOf(o.meter), "where it is drawn, for screenshots");
  o.state({ locked: false });
  o.flush();
  assert.deepEqual(o.lastInput().rects, [rectOf(o.meter)]);
});

test("at rest only its two pills take the mouse, never the space between them", async () => {
  const o = setup();
  await tick();
  o.meter.classList.add("isResting");
  o.window.a2Overlay.meterChanged();
  o.flush();
  assert.equal(o.lastInput().rects.length, 2);
  assert.ok(o.lastInput().rects.every(([x, , w]) => x + w <= 60 || x >= 300), "the pills, not the hidden middle");
});

test("click-through: only the title bar's buttons take the mouse", async () => {
  const o = setup();
  await tick();
  o.state({ clickThrough: true });
  o.flush();
  assert.deepEqual(o.lastInput().rects, [[300, 104, 70, 22]]);
  assert.equal(o.html.classList.contains("meterClickThrough"), true);
});

// 2.0.65's one-time party popup opened at start on a meter left locked: no
// part of it could be clicked. A card takes the mouse whatever the meter's
// state, even hidden.
test("an open card takes the mouse with click-through on, and with the meter hidden", async () => {
  const o = setup();
  await tick();
  o.state({ clickThrough: true });
  o.setCard(true);
  o.window.a2Overlay.meterChanged();
  o.flush();
  assert.deepEqual(o.lastInput().rects, [[800, 400, 360, 300], [300, 104, 70, 22]]);
  o.state({ hidden: true });
  o.flush();
  assert.deepEqual(o.lastInput().rects, [[800, 400, 360, 300]]);
  assert.equal(o.lastInput().meter, null);
  assert.equal(o.html.classList.contains("meterOff"), true);
  o.setCard(false);
  o.window.a2Overlay.meterChanged();
  o.flush();
  assert.deepEqual(o.lastInput().rects, []);
});

test("editing the layout takes the whole screen; a screenshot tool takes nothing", async () => {
  const o = setup();
  await tick();
  o.state({}, { editing: true });
  o.flush();
  assert.equal(o.lastInput().all, true);
  o.state({}, { screenshot: true });
  o.flush();
  assert.deepEqual(o.lastInput().rects, []);
  assert.equal(o.lastInput().all, false);
});

test("a locked meter stays put; unlocked it is dragged, snapped, and its place kept", async () => {
  const o = setup();
  await tick();
  const press = { button: 0, clientX: 100, clientY: 110 };
  assert.equal(o.window.a2Overlay.pressMeter(press), false, "locked");
  o.state({ locked: false });
  o.flush();
  assert.equal(o.window.a2Overlay.pressMeter(press), true);
  assert.equal(o.html.classList.contains("meterLocked"), false);
  // Starts once it has moved a few pixels; the whole screen takes the mouse
  // while it is dragged, so a quick flick never loses it to the game.
  o.window.emit("mousemove", { clientX: 101, clientY: 110, buttons: 1 });
  o.flush();
  assert.equal(o.lastInput().all, false, "a click, not yet a drag");
  o.window.emit("mousemove", { clientX: 140, clientY: 110, buttons: 1 });
  o.flush();
  assert.equal(o.lastInput().all, true);
  o.window.emit("mouseup", {});
  o.flush();
  assert.equal(o.lastInput().all, false);
  const moved = JSON.parse(JSON.stringify(o.calls.filter((c) => c.command === "overlay_meter_moved").at(-1).args));
  // From (10, 108) by 40 px right, on the 8 px grid: (48, 112).
  assert.deepEqual(moved, { x: 48 / 1920, y: 112 / 1080 });
  assert.equal(o.container.style.left, "48px");
  assert.equal(o.container.style.top, "112px");
});

test("the meter's opacity is set on its handle and kept", async () => {
  const o = setup();
  await tick();
  o.state({}, { editing: true });
  o.flush();
  // The meter's handle is the first overlay.js makes, with a slider on it.
  const find = (el) => (el.tag === "input" ? el : el.children.map(find).find(Boolean));
  const slider = find(o.body);
  slider.value = "40";
  slider.emit("input");
  assert.equal(o.container.style.opacity, "0.4");
  slider.emit("change");
  const saved = JSON.parse(JSON.stringify(o.calls.filter((c) => c.command === "overlay_opacity").at(-1).args));
  assert.deepEqual(saved, { plugin: null, name: null, opacity: 0.4 });
});
