// Notices: every module's a2.notify, as a popup over the game (the "toast"
// widget) and a list of the recent ones. The dashboard sends each here as a
// "notice" event (plugins/bundled.rs, plugin_toast).
const $ = (s) => document.querySelector(s);
const DEFAULTS = { on: true, hold: 8, size: 1 };
const MAX_RECENT = 50;
let prefs = { ...DEFAULTS };
let recent = [];
let editing = false;

const save = () => a2.storage.set("prefs", prefs).catch(() => {});
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const size = () => ({ width: Math.round(380 * prefs.size), height: Math.round(250 * prefs.size) });

function render() {
  $(".empty").hidden = recent.length > 0;
  $(".list").replaceChildren(
    ...recent.map((n) => {
      const li = document.createElement("li");
      li.className = "item";
      const text = Object.assign(document.createElement("span"), { className: "grow", textContent: n.text });
      text.append(document.createElement("br"), Object.assign(document.createElement("span"), { className: "sub", textContent: `${n.name || n.from} · ${time(n.at)}` }));
      li.append(text);
      return li;
    }),
  );
}

async function place() {
  if (prefs.on || editing) await a2.widgets.open("toast", size()).catch(() => {});
  else await a2.widgets.close("toast").catch(() => {});
  a2.widgets.send("toast", { config: { hold: prefs.hold * 1000, scale: prefs.size, placing: editing } }).catch(() => {});
}

function notice(n) {
  recent = [n, ...recent].slice(0, MAX_RECENT);
  a2.storage.set("recent", recent).catch(() => {});
  render();
  if (prefs.on) a2.widgets.send("toast", { notice: { title: n.name || n.from, text: n.text, at: Date.now() } }).catch(() => {});
}

a2.on("notice", (n) => n && notice(n));
a2.on("layout", (o) => {
  editing = !!o?.editing;
  place();
});
a2.on("widget-message", ({ data }) => {
  if (data?.open) a2.window?.show?.();
});

for (const [sel, key, read] of [
  [".on", "on", (el) => el.checked],
  [".hold", "hold", (el) => Math.max(2, Math.min(60, Number(el.value) || 8))],
  [".size", "size", (el) => Number(el.value) || 1],
]) {
  $(sel).addEventListener("change", () => {
    prefs[key] = read($(sel));
    save();
    place();
  });
}
$(".test").addEventListener("click", () => notice({ from: "notices", name: "Spacetime Rift", text: "Spacetime Rift opens in 5 min", at: Date.now() }));

(async () => {
  const stored = await a2.storage.get("prefs").catch(() => null);
  if (stored) prefs = { ...DEFAULTS, ...stored };
  recent = (await a2.storage.get("recent").catch(() => null)) || [];
  $(".on").checked = prefs.on;
  $(".hold").value = prefs.hold;
  $(".size").value = prefs.size;
  render();
  await place();
  a2.ready();
})();
