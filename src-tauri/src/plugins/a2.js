// The plugin API (apiVersion 1), loaded by a plugin's page from /_sdk/a2.js.
// A plugin runs in a sandboxed frame: everything goes to the host page as a
// message, and the host passes on only what the manifest's permissions allow.
//
//   a2.on("decoded:pet-list", (data, { character }) => ...)
//                                              one of the plugin's decoders. Each event arrives once,
//                                              in order, even those from while the window was closed
//                                              (since the meter started); `character` is who was
//                                              playing (with events:character), else null; `at` is
//                                              when the meter read it (unix ms), or null on meters
//                                              that don't say
//   a2.on("character", (c) => ...)             your character (name, serverId, class, level), at start and
//                                              whenever it changes (meter 2.0.65 on)
//   a2.on("bossMap", ({ map, bosses }) => ...) a map the player just opened, its field bosses as
//                                              a2.bossTimers gives them (permission
//                                              "feed:boss-timers", meter 2.0.65 on)
//   a2.on("game", ({ running }) => ...)        whether AION2 is open, at start and on change
//                                              (meter 2.0.65 on)
//   a2.on("ping", ({ ms }) => ...)             the ping to the game server in ms (null while not known),
//                                              at start and on change, about every 10 s (meter 2.0.73 on)
//   a2.on("language", (code) => ...)           the meter's language ("en", "ko", "zh-Hans", ...), at start and on change
//   a2.on("combat", (snapshot) => ...)         your casts, the buffs and debuffs on you and your party,
//                                              and PvP, about 4 times a second (permission "feed:combat",
//                                              plugins/bundled.rs and combat/combat_feed.rs for its shape)
//   a2.on("fight", (fight) => ...)             a fight History saved, with your numbers and skills
//                                              (permission "feed:combat"); a boss fight comes again every
//                                              30 s while it lasts, under the same id
//   a2.on("compact", (on) => ...)              the window's fold button: show only the essentials
//
// Keep the page's background transparent: the window paints the panel at the
// opacity the user picks.
//   await a2.storage.get("state")              the plugin's own saved data
//   await a2.storage.set("state", value)
//   a2.notify("Text")                          a short message in the plugin's window
//   await a2.copy("Text")                      text to the clipboard (permission "feed:combat")
//   await a2.systemNotify("Title", "Text")     a desktop notification (permission "notify:system")
//   await a2.armory.character()                you as the official site shows you; or
//   await a2.armory.character({ name, server, refresh })  anyone (permission "feed:armory")
//   await a2.armory.pool({ class, server, extra })  read the players to compare with, each sent as
//                                              a2.on("armory-player", ({ source, character }) => ...),
//                                              progress as a2.on("armory-pool", ...)
//   await a2.bossTimers(serverId)              a server's field boss timers, as players' meters
//                                              share them through a2tools.app (permission
//                                              "feed:boss-timers", meter 2.0.65 on): { bosses: { <id>:
//                                              { state, upSince, nextSpawn, reportedAt, confirmed } } }
//                                              or null
//   await a2.followBosses(serverId, ["101006", ...])  follow these field bosses live (permission
//                                              "feed:boss-timers", meter 2.0.68 on): each change comes at
//                                              once as a2.on("bossLive", (m) => ...), m being
//                                              { type: "state", server, bosses } on following,
//                                              { type: "boss", server, boss, entry } on each change (an
//                                              entry as a2.bossTimers gives it), or
//                                              { type: "status", server, connected }; [] stops
//   a2.window.show() / a2.window.hide()        its own window, shown on top without taking focus
//   a2.window.fit(height) / a2.window.fit()    the window fitted to that much content (an alert),
//                                              its title bar hidden; then back to its size and
//                                              title bar (meter 2.0.65 on)
//                                              (permission "window", plugin API 2)
//   Widgets (permission "widgets", meter 2.0.68 on): small things over the game, each showing the
//   plugin's widget.html (?name=<name>), which the player can drag anywhere and lock in place.
//   This fork shows every plugin's widgets in one overlay over the game's screen; a widget page
//   may use the shared look: <link rel="stylesheet" href="/_sdk/widget.css" />
//   From the plugin's page:
//   await a2.widgets.open("name", { width, height, label })  open one, or show it again; at most 16
//                                              (label: its name while the layout is edited;
//                                              clickable: true, it takes clicks even while locked)
//   await a2.widgets.close("name")
//   await a2.widgets.send("name", data)        the widget hears it: a2.on("widget", (data) => ...)
//   await a2.widgets.lock(true / false)        locked, clicks go through them and they stay put
//   await a2.widgets.locked()                  whether they are locked
//   a2.on("widget-message", ({ name, data }) => ...)  what a widget posted
//   From a widget's page (widget.html):
//   a2.widget.name                             its name
//   a2.widget.drag()                           call on mousedown (or once it moves): the widget
//                                              follows the pointer until the button is let go
//                                              (not while locked)
//   a2.widget.area({ x, y, width, height })    the part of the page that takes the mouse (CSS px);
//                                              elsewhere clicks go through to the game, so widgets
//                                              set close together don't catch each other's drags
//   a2.widget.post(data)                       to the plugin's page ("widget-message")
//   a2.on("widget", (data) => ...)             what the plugin sent it
//   a2.on("locked", (locked) => ...)           whether the widgets are locked, at start and on change
//
//   a2.ready()                                 call once the handlers are set
//
// A link (<a href="https://...">) clicked in the page opens in the browser
// (meter 2.0.65 on; before, the click did nothing).
(() => {
  const handlers = {};
  const pending = new Map();
  let seq = 0;
  const call = (name, args) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ a2: 1, id, call: name, args }, "*");
    });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.a2 !== 1) return;
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
      return;
    }
    if (msg.event) {
      for (const fn of handlers[msg.event] || []) {
        try {
          fn(msg.data, { character: msg.character ?? null, at: msg.at ?? null });
        } catch (e) {
          console.error(e);
        }
      }
    }
  });
  // A widget's drag (fork): the overlay holds every widget, so the frame
  // reports where the pointer is on screen until the button is let go, and
  // the overlay moves the widget with it.
  let pointer = null;
  let pressed = null;
  document.addEventListener("pointerdown", (e) => {
    pressed = { id: e.pointerId, target: e.target };
    pointer = [e.screenX, e.screenY];
  }, true);
  document.addEventListener("pointermove", (e) => (pointer = [e.screenX, e.screenY]), true);
  document.addEventListener("pointerup", () => (pressed = null), true);
  function dragWidget() {
    if (!pressed || !pointer) return Promise.resolve(false);
    const { id, target } = pressed;
    try {
      target.setPointerCapture?.(id);
    } catch {}
    let frame = 0;
    const move = (e) => {
      pointer = [e.screenX, e.screenY];
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        call("widget.dragMove", pointer).catch(() => {});
      });
    };
    const end = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      if (frame) cancelAnimationFrame(frame);
      call("widget.dragMove", pointer).catch(() => {});
      call("widget.dragEnd", []).catch(() => {});
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
    return call("widget.drag", pointer);
  }
  window.a2 = Object.freeze({
    on(event, fn) {
      (handlers[event] ||= []).push(fn);
    },
    storage: Object.freeze({
      get: (key) => call("storage.get", [key]).then((v) => (v == null ? null : JSON.parse(v))),
      set: (key, value) => call("storage.set", [key, JSON.stringify(value)]),
    }),
    notify: (text) => call("notify", [String(text)]),
    // Fork: text to the clipboard (permission "feed:combat").
    copy: (text) => call("clipboard.write", [String(text)]),
    // Fork: a desktop notification (permission "notify:system").
    systemNotify: (title, body) => call("notify.system", [String(title), String(body)]),
    // Fork: the World Map's images and marker files (permission "maps").
    map: Object.freeze({
      image: (map) => call("map.image", [Number(map)]),
      pickImage: (map) => call("map.pickImage", [Number(map)]),
      saveImage: (map, dataUrl) => call("map.saveImage", [Number(map), String(dataUrl)]),
      pickMarkers: () => call("map.pickMarkers", []),
      // The game's top-right corner, where its minimap is: { png, gameWidth, gameHeight }.
      minimap: () => call("map.minimap", []),
    }),
    // Fork: characters from the official site (permission "feed:armory").
    armory: Object.freeze({
      character: (who) => call("armory.character", [who || null]),
      pool: (opts) => call("armory.pool", [opts || {}]),
    }),
    bossTimers: (server) => call("bossTimers", [Number(server)]),
    // Meter 2.0.72 on: the server's Abyss siege (artifact holders, cores).
    abyssSiege: (server) => call("abyssSiege", [Number(server)]),
    followBosses: (server, bosses) => call("bossTimers.follow", [Number(server), (bosses || []).map(String)]),
    window: Object.freeze({
      show: () => call("window.show", []),
      hide: () => call("window.hide", []),
      fit: (height) => call("window.fit", [height ?? null]),
    }),
    widgets: Object.freeze({
      open: (name, size) => call("widgets.open", [String(name), size || {}]),
      close: (name) => call("widgets.close", [String(name)]),
      send: (name, data) => call("widgets.send", [String(name), data]),
      lock: (locked) => call("widgets.lock", [!!locked]),
      locked: () => call("widgets.locked", []),
      // Meter 2.0.72 on: where a widget is, and moving it (physical screen
      // pixels), for a plugin that lays its widgets out itself.
      where: (name) => call("widgets.where", [String(name)]),
      place: (name, at) => call("widgets.place", [String(name), { x: Number(at?.x), y: Number(at?.y) }]),
    }),
    // Fork: the dashboard's Edit layout, from a module in it (permission "widgets").
    overlay: Object.freeze({
      edit: (on = true) => call("overlay.edit", [on !== false]),
    }),
    widget: Object.freeze({
      name: new URLSearchParams(location.search).get("name") || "",
      drag: () => dragWidget(),
      area: (r) => call("widget.area", [r || {}]),
      post: (data) => call("widget.post", [data]),
    }),
    ready: () => call("ready", []),
  });
  // The frame may not open windows or leave its page: links go to the browser.
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link || !/^https:\/\//i.test(link.href)) return;
    event.preventDefault();
    call("openUrl", [link.href]).catch((e) => console.warn(e));
  });
})();
