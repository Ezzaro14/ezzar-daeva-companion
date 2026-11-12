import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/src/js/tauriBridge.js", import.meta.url), "utf8");
const startup = source.slice(source.indexOf("  const { invoke }"), source.indexOf("  // Three windows"));
const meter = source.slice(source.indexOf("  // ===== Moving the meter"), source.indexOf("  // ===== Tool windows: drag by the header"));
const tool = source.slice(source.indexOf("  // ===== Tool windows: drag by the header"), source.indexOf("  // Pre-fetch device list"));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup({ userAgent = "Linux", supported = false, view = "main", detect } = {}) {
  const calls = [];
  const nativeResizes = [];
  const events = new Map();
  const classes = new Set();
  const document = {
    readyState: "complete",
    body: { classList: { add: (value) => classes.add(value) } },
    documentElement: { classList: { add() {}, remove() {}, contains: (name) => name === "linux" && /Linux/.test(userAgent) } },
    head: { appendChild() {} },
    createElement: () => ({}),
    addEventListener(name, handler) {
      const handlers = events.get(name) || [];
      handlers.push(handler);
      events.set(name, handlers);
    },
  };
  const window = {
    A2_VIEW: view, devicePixelRatio: 1,
    __TAURI__: {
      core: { invoke: (command, args) => {
        // Every page asks which optional parts the build has; not a window call.
        if (command === "build_features") return Promise.resolve({ online: true });
        calls.push({ command, args });
        return command === "compositor_resize_supported" && detect
          ? detect : Promise.resolve(command === "compositor_resize_supported" ? supported : null);
      } },
      event: { listen() {} }, opener: { open() {} },
      window: { getCurrentWindow: () => ({ startResizeDragging: (direction) => calls.push({ command: "startResizeDragging", direction }) }) },
    },
  };
  const pressed = [];
  window.a2Overlay = { pressMeter: (event) => pressed.push(event) };
  const context = vm.createContext({
    window, document, navigator: { userAgent }, console, Node: { TEXT_NODE: 3 },
    viewMode: view, nativeResize: null, primaryHeld: true,
    startNativeResize: (...args) => nativeResizes.push(args),
  });
  vm.runInContext(startup, context);
  vm.runInContext(tool, context);
  vm.runInContext(meter, context);
  const emit = (name, event) => (events.get(name) || []).forEach((handler) => handler(event));
  return { calls, nativeResizes, classes, emit, context, pressed };
}

function pressHandle() {
  return {
    button: 0,
    target: { closest: (selector) => selector === ".resizeHandle" },
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
}

test("Windows tool windows drag from the header by the page, not by app-region", () => {
  // -webkit-app-region made WebView2 move a helper window on every layout
  // change, and that froze the whole app for seconds at a time.
  const app = setup({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", view: "settings" });
  const header = (inButton) => ({
    button: 0, clientX: 200, clientY: 20,
    target: { closest: (selector) => selector.includes(".settingsHeader") || (inButton && selector.includes("button")) },
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  });
  const press = header(false);
  app.emit("mousedown", press);
  assert.equal(app.calls.at(-1)?.command, "start_tool_drag");
  assert.equal(press.prevented, true);
  const before = app.calls.length;
  const onButton = header(true);
  app.emit("mousedown", onButton);
  assert.equal(app.calls.length, before, "a header button is clicked, not dragged");
  assert.equal(onButton.prevented, undefined);
});

test("other Linux desktops keep the begin_tool_resize edge path", async () => {
  const app = setup({ supported: false, view: "details" });
  await tick();
  app.emit("mousedown", {
    ...pressHandle(), clientX: 1, clientY: 1,
    target: { closest: () => false },
  });
  await tick();
  assert.equal(app.calls.at(-2).command, "begin_tool_resize");
  assert.equal(app.calls.at(-2).args.minWidth, 520);
  assert.equal(app.calls.at(-1).command, "startResizeDragging");
  assert.equal(app.calls.at(-1).direction, "NorthWest");
  assert.equal(app.nativeResizes.length, 0);
});

test("GNOME and KDE use compositor resizing for the tool windows' edges", async () => {
  const toolApp = setup({ supported: true, view: "details" });
  await tick();
  toolApp.emit("mousedown", { ...pressHandle(), clientX: 1, clientY: 1, target: { closest: () => false } });
  await tick();
  assert.deepEqual(toolApp.nativeResizes[0], ["NorthWest", 520, 360]);
  assert.equal(toolApp.calls.some((call) => call.command === "begin_tool_resize"), false);
});

// The meter is part of the overlay (overlay.js): its window is the screen,
// so its corner handle resizes it in the page (core.js bindResizeHandle) and
// a press on it is never taken here, on any desktop.
test("the meter's corner handle is the page's, never a window resize", async () => {
  for (const userAgent of ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Linux"]) {
    for (const supported of [false, true]) {
      const app = setup({ userAgent, supported });
      await tick();
      const press = pressHandle();
      app.emit("mousedown", press);
      await tick();
      assert.equal(press.stopped, undefined, "core.js gets the press");
      assert.equal(press.prevented, undefined);
      assert.deepEqual(app.nativeResizes, []);
      const windowCalls = app.calls.filter((call) => call.command !== "compositor_resize_supported");
      assert.deepEqual(windowCalls, [], "no window call");
      assert.deepEqual(app.pressed, [], "not a move either");
    }
  }
});

// A press on the meter's title bar or an empty part of it moves the meter in
// the overlay (pressMeter), not its window; buttons and rows keep their clicks.
test("a press on the meter moves it in the overlay, and its buttons and rows still click", () => {
  const app = setup({ userAgent: "Linux" });
  const pressOn = (...selectors) => ({
    button: 0,
    target: { closest: (selector) => selectors.some((s) => selector.split(",").map((x) => x.trim()).includes(s)) },
    stopImmediatePropagation() { this.stopped = true; },
  });
  const bar = pressOn(".meter");
  app.emit("mousedown", bar);
  assert.equal(bar.stopped, true);
  assert.deepEqual(app.pressed, [bar]);
  for (const target of [".headerBtn", ".item", "button", ".bossIcon"]) {
    const press = pressOn(".meter", target);
    app.emit("mousedown", press);
    assert.equal(press.stopped, undefined, `${target} keeps its click`);
  }
  assert.equal(app.pressed.length, 1);
  assert.equal(app.calls.some((call) => call.command === "start_drag"), false);

  const details = setup({ userAgent: "Linux", view: "details" });
  details.emit("mousedown", pressOn(".meter"));
  assert.deepEqual(details.pressed, [], "only the meter's own page has a meter to move");
});
