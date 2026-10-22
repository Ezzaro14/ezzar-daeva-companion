import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const dir = new URL("../src-tauri/bundled-plugins/event-timers/", import.meta.url);
const widgetSource = readFileSync(new URL("bosslist-widget.js", dir), "utf8");
const listSource = readFileSync(new URL("bosslist.js", dir), "utf8");

// The Timers list widget on the overlay, with what it posts and whether it is open.
function widget() {
  const posted = [];
  const heard = {};
  const listeners = {};
  let open = false;
  const box = {
    hidden: true,
    innerHTML: "",
    classList: { toggle: (c, on) => c === "open" && (open = on) },
    querySelector: () => null,
    addEventListener: (type, fn) => (listeners[type] = fn),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 340, height: 40 }),
  };
  const context = vm.createContext({
    a2: {
      widget: { name: "bosses", post: async (d) => posted.push(d), area: async () => {}, drag: async () => {} },
      on: (event, fn) => (heard[event] = fn),
    },
    window: {},
    document: { querySelector: () => box, body: { classList: { add() {}, toggle() {} } }, addEventListener() {} },
    addEventListener() {},
  });
  vm.runInContext(widgetSource, context);
  const title = { dataset: { act: "toggle" } };
  return {
    posted,
    open: () => open,
    send: (d) => heard.widget({ kind: "bosslist", tracked: 1, rows: [], ...d }),
    clickTitle: () => listeners.click({ target: { closest: (sel) => (sel === "[data-act]" ? title : null) } }),
  };
}

// A click on the list in game opened it and it folded shut again: data the
// plugin sent before it heard the click folded it back.
test("a click opens the Timers list, and data sent before the plugin heard it doesn't fold it back", () => {
  const w = widget();
  w.send({ expanded: false });
  w.clickTitle();
  assert.equal(w.open(), true);
  assert.deepEqual({ ...w.posted.at(-1) }, { toggle: true, expanded: true });
  w.send({ expanded: false });
  assert.equal(w.open(), true, "stale data must not fold it");
  w.send({ expanded: true });
  w.send({ expanded: false });
  assert.equal(w.open(), false, "once the plugin agreed, its word is taken again");
});

// The plugin's side: the list's state, settings and what it sends.
function plugin(prefs = {}) {
  const heard = {};
  const sent = [];
  const context = vm.createContext({
    prefs: { tracked: { a: true }, ...prefs },
    savePrefs() {},
    a2: {
      on: (event, fn) => (heard[event] = fn),
      widgets: { open: async () => {}, send: async (name, data) => sent.push(data) },
    },
    clock: () => ({ format: () => "12:00" }),
    serverId: () => 2310,
    defaultLead: () => 5,
    document: { querySelector: () => null },
    setInterval() {},
  });
  vm.runInContext(listSource, context);
  // What is tracked, worked out from plugin.js's tables: nothing, unless a test says.
  context.bossListRows = () => ({ rows: [], unknown: 0 });
  return { context, sent, message: (data) => heard["widget-message"]({ name: "bosses", data }) };
}

test("the list's fold is the one the click left, so a message heard twice changes nothing", () => {
  const p = plugin({ bossListExpanded: false });
  p.message({ toggle: true, expanded: true });
  p.message({ toggle: true, expanded: true });
  assert.equal(p.context.prefs.bossListExpanded, true);
  // A widget from before says only that it was clicked.
  p.message({ toggle: true });
  assert.equal(p.context.prefs.bossListExpanded, false);
});

test("Settings → Timers list: folded shows what is near when asked, and open lists as many as picked", async () => {
  const now = Date.now();
  const row = (id, group, inMs) => ({ id, name: id, group, sort: now + inMs, at: group === "upcoming" ? now + inMs : null, when: "" });
  const rows = [row("up", "up", 0), row("soon", "upcoming", 10 * 60_000), row("later", "upcoming", 2 * 3600_000),
    ...Array.from({ length: 6 }, (_, i) => row(`more${i}`, "upcoming", (3 + i) * 3600_000))];
  const p = plugin({ bossListFolded: "near", bossListRows: 5 });
  p.context.bossListRows = () => ({ rows: rows.map((r) => ({ ...r })), unknown: 0 });
  await p.context.sendBossList();
  const data = p.sent.at(-1);
  assert.deepEqual(Array.from(data.rows, (r) => [r.id, r.near]), [["up", true], ["soon", true], ["later", false], ["more0", false], ["more1", false]]);
  assert.equal(data.more, 4);

  const plain = plugin();
  plain.context.bossListRows = () => ({ rows: rows.map((r) => ({ ...r })), unknown: 0 });
  await plain.context.sendBossList();
  assert.ok(plain.sent.at(-1).rows.every((r) => !r.near), "folded is one line unless asked");
  assert.equal(plain.sent.at(-1).rows.length, 9);
});
