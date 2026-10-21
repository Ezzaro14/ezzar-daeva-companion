// The dashboard (plugins/bundled.rs): every bundled plugin as a page of one
// window, and one set of controls for everything on screen. Each plugin runs
// in a sandboxed frame of its own, as in its own window (pluginHost.js): it
// asks for things by message, and this page passes on what its manifest
// permits, naming the plugin to the backend (`plugin`), since every frame
// shares this one window.
(() => {
  const { invoke, convertFileSrc } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const $ = (s) => document.querySelector(s);

  // Where each module sits in the sidebar, and its icon (lucide).
  const LAYOUT = [
    ["Combat", [["combat-assist", "swords"], ["combat-alerts", "siren"], ["pvp-overlay", "crosshair"], ["fight-records", "trophy"], ["dungeon-runs", "castle"]]],
    ["World", [["event-timers", "alarm-clock"], ["world-map", "map"], ["pet-souls", "paw-print"]]],
    ["Character", [["progression-guide", "graduation-cap"], ["daily-planner", "calendar-check"]]],
    ["Tools", [["notices", "bell"], ["ping", "wifi"]]],
  ];
  const ICONS = Object.fromEntries(LAYOUT.flatMap(([, items]) => items));

  let modules = [];
  const hosts = new Map(); // id → module host
  let current = "home";
  let overlay = { locked: false, editing: false, hidden: false, meterShown: true };
  let game = false;
  let character = null;

  // ── a module's frame and its bridge ───────────────────────────────────────

  function createHost(mod) {
    const id = mod.id;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.hidden = true;
    frame.title = mod.name;
    let manifest = null;
    let ready = false;
    const queue = [];
    let run = null;
    let delivered = 0;
    let early = [];
    const CURSOR_KEY = `dashboard.cursor.${id}`;
    const allowed = (p) => !!manifest?.permissions?.includes(p);
    const need = (p) => {
      if (!allowed(p)) throw new Error(`the plugin lacks the "${p}" permission`);
    };
    const send = (msg) => frame.contentWindow?.postMessage({ a2: 1, ...msg }, "*");
    const call = (cmd, args = {}) => invoke(cmd, { ...args, plugin: id });
    const saveCursor = () => {
      try { localStorage.setItem(CURSOR_KEY, JSON.stringify({ run, seq: delivered })); } catch {}
    };
    const deliver = (event, data, extra = {}) => {
      if (event.startsWith("decoded:") && !allowed(`decoder:${event.slice(8)}`)) return;
      if (event === "character" && !allowed("events:character")) return;
      if ((event === "bossMap" || event === "bossLive" || event === "abyss") && !allowed("feed:boss-timers")) return;
      if ((event === "combat" || event === "fight") && !allowed("feed:combat")) return;
      const msg = { event, data, ...extra };
      if (ready) send(msg);
      else queue.push(msg);
    };
    const deliverLogged = (e) => {
      if (typeof e?.seq !== "number" || e.seq <= delivered) return;
      delivered = e.seq;
      deliver(e.event, e.data, { character: e.character ?? null, at: e.at ?? null });
      if (ready) saveCursor();
    };

    let lastLinkAt = 0;
    const calls = {
      ready: () => {
        ready = true;
        for (const m of queue.splice(0)) send(m);
        saveCursor();
        return true;
      },
      "storage.get": ([key]) => call("plugin_storage_get", { key: String(key) }),
      "storage.set": ([key, value]) => call("plugin_storage_set", { key: String(key), value: String(value) }),
      bossTimers: ([server]) => (need("feed:boss-timers"), call("plugin_boss_timers", { server: Number(server) })),
      abyssSiege: ([server]) => (need("feed:boss-timers"), call("plugin_abyss_siege", { server: Number(server) })),
      "bossTimers.follow": ([server, bosses]) => (
        need("feed:boss-timers"),
        call("plugin_boss_follow", { server: Number(server), bosses: (Array.isArray(bosses) ? bosses : []).map(String) })
      ),
      // In the dashboard a plugin's "window" is its page: showing it opens
      // the dashboard there; hiding and fitting it are for windows of their own.
      "window.show": () => (need("window"), invoke("dashboard_open", { module: id })),
      "window.hide": () => (need("window"), true),
      "window.fit": () => (need("window"), true),
      "widgets.open": ([name, size]) => (
        need("widgets"),
        call("plugin_widget_open", { name: String(name), width: Number(size?.width) || 64, height: Number(size?.height) || 64, label: size?.label ? String(size.label) : null, clickable: !!size?.clickable })
      ),
      // Edit layout, from a module's own page ("Place on screen").
      "overlay.edit": ([on]) => (need("widgets"), invoke("overlay_edit", { editing: on !== false })),
      "widgets.close": ([name]) => (need("widgets"), call("plugin_widget_close", { name: String(name) })),
      "widgets.send": ([name, data]) => (need("widgets"), call("plugin_widget_send", { name: String(name), data: data ?? null })),
      "widgets.lock": ([locked]) => (need("widgets"), invoke("overlay_lock_all", { locked: !!locked })),
      "widgets.locked": () => (need("widgets"), call("plugin_widgets_locked")),
      "widgets.where": ([name]) => (need("widgets"), call("plugin_widget_where", { name: String(name) })),
      "widgets.place": ([name, at]) => (
        need("widgets"),
        call("plugin_widget_place", { name: String(name), x: Math.round(Number(at?.x)), y: Math.round(Number(at?.y)) })
      ),
      // A short message: on screen, as a notice (the Notices plugin), and here.
      notify: ([text]) => {
        need("notify");
        toast(mod.name, String(text));
        return call("plugin_toast", { text: String(text) });
      },
      "armory.character": ([who]) => (
        need("feed:armory"),
        call("plugin_armory_character", { name: who?.name ?? null, server: who?.server ?? null, refresh: !!who?.refresh })
      ),
      "armory.pool": ([o]) => (
        need("feed:armory"),
        call("plugin_armory_pool", { class: Number(o?.class) || 0, server: Number(o?.server) || 0, extra: Array.isArray(o?.extra) ? o.extra : [] })
      ),
      "map.image": ([map]) => (need("maps"), call("plugin_map_image", { map: Number(map) || 0 })),
      "map.pickImage": ([map]) => (need("maps"), call("plugin_map_pick_image", { map: Number(map) || 0 })),
      "map.saveImage": ([map, data]) => (need("maps"), call("plugin_map_save_image", { map: Number(map) || 0, data: String(data) })),
      "map.pickMarkers": () => (need("maps"), call("plugin_map_pick_markers")),
      "map.minimap": () => (need("maps"), call("plugin_map_minimap")),
      "clipboard.write": ([text]) => (need("feed:combat"), call("plugin_copy_text", { text: String(text) })),
      "notify.system": ([title, body]) => (need("notify:system"), call("plugin_system_notify", { title: String(title), body: String(body) })),
      openUrl: ([raw]) => {
        const url = new URL(String(raw));
        if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) throw new Error("only https links open");
        if (Date.now() - lastLinkAt < 1000) throw new Error("one link a second");
        lastLinkAt = Date.now();
        return invoke("open_url", { url: url.href });
      },
    };

    const onMessage = async (event) => {
      if (event.source !== frame.contentWindow) return;
      const msg = event.data;
      if (!msg || msg.a2 !== 1 || !msg.id || typeof msg.call !== "string") return;
      const fn = calls[msg.call];
      try {
        if (!fn) throw new Error(`unknown call ${msg.call}`);
        send({ id: msg.id, result: await fn(Array.isArray(msg.args) ? msg.args : []) });
      } catch (e) {
        send({ id: msg.id, error: String(e?.message || e) });
      }
    };
    window.addEventListener("message", onMessage);

    const host = {
      id,
      mod,
      frame,
      // An event from the meter for this plugin (or for all).
      hear(payload) {
        if (payload.event === "widget" || payload.event === "locked") return;
        if ((payload.event === "widget-message" || payload.event === "widget-moved") && !allowed("widgets")) return;
        if (typeof payload.seq !== "number") deliver(payload.event, payload.data);
        else if (early) early.push(payload);
        else deliverLogged(payload);
      },
      async start() {
        const hello = await call("plugin_hello");
        manifest = hello.manifest;
        deliver("language", hello.language || "en");
        deliver("compact", false);
        deliver("hosted", true);
        if (hello.character) deliver("character", hello.character);
        if (typeof hello.game === "boolean") {
          deliver("game", { running: hello.game });
          // A "game" event comes only on a change: the game already open
          // when the app started is known from here alone.
          if (hello.game !== game) {
            game = hello.game;
            renderStatus();
          }
        }
        if ("ping" in hello) deliver("ping", { ms: typeof hello.ping === "number" ? hello.ping : null });
        deliver("layout", overlay);
        run = hello.run;
        try {
          const cursor = JSON.parse(localStorage.getItem(CURSOR_KEY) || "null");
          if (cursor?.run === run) delivered = Number(cursor.seq) || 0;
        } catch {}
        const logged = [...(hello.replay || []), ...early].sort((a, b) => a.seq - b.seq);
        early = null;
        for (const e of logged) deliverLogged(e);
        const base = convertFileSrc("", "a2plugin").replace(/\/*$/, "/");
        frame.src = `${base}${encodeURIComponent(id)}/index.html`;
        $(".frames").appendChild(frame);
      },
      stop() {
        window.removeEventListener("message", onMessage);
        frame.remove();
      },
    };
    return host;
  }

  // ── pages ─────────────────────────────────────────────────────────────────

  const icon = (name) => `<i data-lucide="${name}"></i>`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function renderNav() {
    const nav = $(".nav");
    const byId = new Map(modules.map((m) => [m.id, m]));
    const button = (page, label, iconName, extra = "") =>
      `<button type="button" class="navBtn ${extra}" data-page="${esc(page)}" ${current === page ? 'aria-current="page"' : ""}>${icon(iconName)}<span>${esc(label)}</span></button>`;
    let html = button("home", "Home", "layout-dashboard") + button("overlay", "Overlay", "layers");
    const placed = new Set();
    for (const [group, items] of LAYOUT) {
      const here = items.filter(([id]) => byId.has(id));
      if (!here.length) continue;
      html += `<div class="navGroup">${esc(group)}</div>`;
      for (const [id] of here) {
        placed.add(id);
        const m = byId.get(id);
        html += button(id, m.name, ICONS[id], m.enabled ? "" : "off");
      }
    }
    const rest = modules.filter((m) => !placed.has(m.id));
    if (rest.length) {
      html += `<div class="navGroup">More</div>`;
      for (const m of rest) html += button(m.id, m.name, "puzzle", m.enabled ? "" : "off");
    }
    nav.innerHTML = html;
    window.lucide?.createIcons?.({ root: nav });
  }

  function show(page) {
    if (page !== "home" && page !== "overlay" && !modules.some((m) => m.id === page)) page = "home";
    current = page;
    try { localStorage.setItem("dashboard.page", page); } catch {}
    for (const btn of document.querySelectorAll(".navBtn[data-page]")) {
      if (btn.dataset.page === page) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }
    const mod = modules.find((m) => m.id === page);
    $(".pageTitle").textContent = page === "home" ? "Home" : page === "overlay" ? "Overlay" : mod?.name || "";
    $(".home").hidden = page !== "home";
    $(".overlayPage").hidden = page !== "overlay";
    for (const h of hosts.values()) h.frame.hidden = h.id !== page;
    $(".frames").classList.toggle("idle", !hosts.has(page));
    if (page === "home") renderHome();
    if (page === "overlay") renderOverlay();
    if (mod && !mod.enabled) renderOff(mod);
  }

  // A module that is turned off: say so, with the switch to turn it on.
  function renderOff(mod) {
    const home = $(".home");
    home.hidden = false;
    home.innerHTML = `<div class="card"><div class="cardHead">${icon(ICONS[mod.id] || "puzzle")} ${esc(mod.name)} is turned off</div>
      <div class="cardText">${esc(mod.description)}</div><p><button type="button" class="btn turnOn">Turn it on</button></p></div>`;
    window.lucide?.createIcons?.({ root: home });
    home.querySelector(".turnOn").addEventListener("click", () => setEnabled(mod.id, true));
  }

  function renderHome() {
    const home = $(".home");
    const who = character?.name
      ? `${esc(character.name)} · level ${esc(character.level ?? "?")}`
      : "Log in to a character and the app picks it up from the game.";
    const card = (id, text) => {
      const m = modules.find((x) => x.id === id);
      if (!m) return "";
      return `<div class="card link" data-go="${esc(id)}"><div class="cardHead">${icon(ICONS[id] || "puzzle")} ${esc(m.name)}</div><div class="cardText">${esc(text || m.description)}</div></div>`;
    };
    home.innerHTML = `
      <div class="cards">
        <div class="card link tourCard"><div class="cardHead">${icon("compass")} Setup guide</div><div class="cardText">A step at a time through the app: your screen, what to track, and the rest.</div></div>
        <div class="card"><div class="cardHead">${icon("user")} Character</div><div class="cardText">${who}</div></div>
        <div class="card"><div class="cardHead">${icon("gamepad-2")} AION 2</div><div class="big">${game ? "Running" : "Not running"}</div></div>
        <div class="card link" data-go="overlay"><div class="cardHead">${icon("layers")} On screen</div>
          <div class="cardText">${overlay.hidden ? "Hidden" : overlay.editing ? "Editing the layout" : overlay.locked ? "Locked: clicks go through to the game" : "Unlocked: the overlay's widgets take clicks"}</div></div>
      </div>
      <h2>Combat</h2>
      <div class="cards">
        ${card("combat-assist", "Cooldown and buff bars, placed anywhere over the game.")}
        ${card("combat-alerts", "Stun and other loss-of-control notices; enemy debuffs on your party.")}
        ${card("pvp-overlay", "Opponents, damage both ways, kills and sessions.")}
        ${card("fight-records", "Personal bests, recent fights, training runs and comparisons.")}
        ${card("dungeon-runs", "Clear times, deaths and everyone's numbers per run.")}
      </div>
      <h2>World</h2>
      <div class="cards">
        ${card("event-timers", "Rifts, Shugo Festival, sieges, world bosses: countdowns and alerts.")}
        ${card("world-map", "")}
        ${card("pet-souls", "Souls still needed per pet, and where they drop.")}
      </div>
      <h2>Character</h2>
      <div class="cards">${card("progression-guide", "Your gear, Daevanion boards and skills against the strongest of your class: what to improve first.")}${card("daily-planner", "What to do each day and week, with a reminder before a reset.")}</div>
      <p class="note">The meter itself is the small window over the game; its fight history and settings open from the sidebar. Everything here keeps running with this window closed.</p>`;
    window.lucide?.createIcons?.({ root: home });
    for (const el of home.querySelectorAll("[data-go]")) el.addEventListener("click", () => show(el.dataset.go));
    home.querySelector(".tourCard")?.addEventListener("click", () => startTour());
  }

  function renderOverlay() {
    const page = $(".overlayPage");
    const rows = modules
      .map(
        (m) => `<div class="row">
          <span>${icon(ICONS[m.id] || "puzzle")}</span>
          <div class="grow"><div>${esc(m.name)}</div><div class="sub">${esc(m.description)}</div></div>
          <button type="button" class="btn" data-open="${esc(m.id)}">Settings</button>
          <label class="switch" title="On: it runs, and its overlays can show"><input type="checkbox" data-module="${esc(m.id)}" ${m.enabled ? "checked" : ""}><span></span></label>
        </div>`,
      )
      .join("");
    page.innerHTML = `
      <h2>Everything on screen</h2>
      <p class="note">Every bar, alert and timer is on one overlay over the game, on the game's screen.</p>
      <div class="cards">
        <div class="card"><div class="cardHead">${icon("move")} Edit layout</div><div class="cardText">Shows everything (alerts as samples) on a grid, to drag into place. Press Done on the screen, or Edit layout again.</div></div>
        <div class="card"><div class="cardHead">${icon("lock")} Lock</div><div class="cardText">Clicks go through the overlay to the game. Unlocked, its widgets take clicks.</div></div>
        <div class="card"><div class="cardHead">${icon("eye-off")} Hide all</div><div class="cardText">The meter and the overlay out of sight, until shown again.</div></div>
      </div>
      <div class="row screenRow">
        <span>${icon("monitor")}</span>
        <div class="grow"><div>Screen</div><div class="sub">Where the overlay goes. Automatic follows the game to whichever screen it is on.</div></div>
        <select class="screenPick"><option value="">Automatic (the game's screen)</option></select>
        <button type="button" class="btn resetLayout">Reset layout</button>
      </div>
      <h2>Modules</h2>
      ${rows}
      <p class="note">What each module puts on screen is set on its own page. Turning a module off stops it and closes its overlays.</p>`;
    window.lucide?.createIcons?.({ root: page });
    for (const box of page.querySelectorAll("input[data-module]")) box.addEventListener("change", () => setEnabled(box.dataset.module, box.checked));
    for (const btn of page.querySelectorAll("[data-open]")) btn.addEventListener("click", () => show(btn.dataset.open));
    page.querySelector(".resetLayout").addEventListener("click", () => invoke("overlay_reset_layout").catch(() => {}));
    const pick = page.querySelector(".screenPick");
    invoke("overlay_screens")
      .then(({ screens, picked }) => {
        for (const sc of screens || []) {
          const label = [sc.label, sc.key].filter(Boolean).join(" · ");
          pick.append(new Option(`${label} (${sc.width}×${sc.height})`, sc.key));
        }
        if (picked && ![...pick.options].some((o) => o.value === picked)) pick.append(new Option(`${picked} (not connected)`, picked));
        pick.value = picked || "";
      })
      .catch(() => {});
    pick.addEventListener("change", () => invoke("overlay_set_screen", { key: pick.value }).catch((e) => toast("Screen", String(e))));
  }

  async function setEnabled(id, enabled) {
    try {
      await invoke("plugin_set_enabled", { id, enabled });
    } catch (e) {
      toast("Couldn't change it", String(e));
    }
    await loadModules();
    show(current);
  }

  // ── the controls for everything on screen ─────────────────────────────────

  function renderControls() {
    $(".ctlLock").setAttribute("aria-pressed", String(overlay.locked && !overlay.editing));
    $(".ctlEdit").setAttribute("aria-pressed", String(overlay.editing));
    $(".ctlHide").setAttribute("aria-pressed", String(overlay.hidden));
    $(".ctlMeter").setAttribute("aria-pressed", String(overlay.meterShown));
    $(".ctlLock span").textContent = overlay.locked ? "Locked" : "Lock";
    $(".ctlHide span").textContent = overlay.hidden ? "Show all" : "Hide all";
  }
  $(".ctlLock").addEventListener("click", () => invoke("overlay_lock_all", { locked: !overlay.locked }));
  $(".ctlEdit").addEventListener("click", () => invoke("overlay_edit", { editing: !overlay.editing }));
  $(".ctlHide").addEventListener("click", () => invoke("overlay_show_all", { shown: overlay.hidden }));
  $(".ctlMeter").addEventListener("click", async () => {
    await invoke("set_meter_shown", { shown: !overlay.meterShown }).catch(() => {});
    overlay = await invoke("overlay_state");
    renderControls();
  });
  for (const btn of document.querySelectorAll(".sideFoot [data-action]")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "history") invoke("request_details_view", { payload: { kind: "history" } }).catch((e) => toast("History", String(e)));
      if (btn.dataset.action === "settings") invoke("open_settings_window").catch((e) => toast("Settings", String(e)));
    });
  }

  let toastTimer = 0;
  function toast(title, text) {
    const el = $(".dashToast");
    el.innerHTML = `<b>${esc(title)}</b>${esc(text).slice(0, 300)}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 5000);
  }

  // ── wiring ────────────────────────────────────────────────────────────────

  async function loadModules() {
    const list = (await invoke("dashboard_modules")).modules || [];
    modules = list;
    // Start the ones turned on, stop those turned off.
    for (const m of modules) {
      if (m.enabled && !hosts.has(m.id)) {
        const h = createHost(m);
        hosts.set(m.id, h);
        h.start().catch((e) => console.error(`[dashboard] ${m.id}`, e));
      } else if (!m.enabled && hosts.has(m.id)) {
        hosts.get(m.id).stop();
        hosts.delete(m.id);
      }
    }
    renderNav();
  }

  $(".nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".navBtn[data-page]");
    if (btn) show(btn.dataset.page);
  });

  // Only events sent to this window: a plain `listen` hears every window's,
  // and each plugin event goes to its plugin's own window as well, so every
  // one came twice (a fold toggled twice stayed shut).
  window.__TAURI__.webviewWindow.getCurrentWebviewWindow().listen("plugin-event", (event) => {
    const payload = event.payload || {};
    if (typeof payload.event !== "string") return;
    if (payload.event === "character") {
      character = payload.data;
      if (current === "home") renderHome();
    }
    if (payload.event === "game") {
      game = !!payload.data?.running;
      renderStatus();
    }
    if (payload.plugin !== undefined) hosts.get(payload.plugin)?.hear(payload);
    else for (const h of hosts.values()) h.hear(payload);
  });
  listen("overlay-state", (event) => {
    overlay = event.payload || overlay;
    renderControls();
    if (current === "home") renderHome();
  });
  listen("dashboard-show", (event) => show(String(event.payload || "home")));

  function renderStatus() {
    $(".dot").classList.toggle("on", game);
    $(".statusText").textContent = game ? "AION 2 running" : "Game not running";
    if (current === "home") renderHome();
  }

  // ── the setup guide ───────────────────────────────────────────────────────
  // On first start, a step at a time across the top: each step shows its
  // page and says what it is for and what to do there. Every step can be
  // skipped; it runs again from Home.
  const TOUR_KEY = "dashboard.tour";
  const TOUR = [
    { page: "home", title: "Welcome",
      text: "Everything is in this window: the modules down the left, and at the top the controls for what's on screen. Over the game there is one overlay, and it lets every click through to the game (Locked). This takes a couple of minutes, and any step can be skipped." },
    { page: "overlay", title: "Your screen and modules",
      text: "Pick the screen the overlay goes on (Automatic follows the game). Turn off what you don't use: fewer modules, less on screen. You can turn any of them back on here later." },
    { page: "event-timers", title: "What to track", setup: true,
      text: "Tick the world bosses, Abyss bosses and events you follow. Only those show in the Timers list over the game, and each gets a popup a few minutes before it starts. Everything else stays out of the way." },
    { page: "combat-assist", title: "Cooldown bars (optional)",
      text: "Want your skill cooldowns and buffs over the game? Use your skills in game, add them here, then place the bar. Not for you? Skip it." },
    { page: "combat-alerts", title: "Alerts",
      text: "A stun or a party debuff pops up over the game when it happens; nothing shows otherwise. Pick which ones here." },
    { page: "world-map", title: "Your map",
      text: "Paste a screenshot of the game's world map (Ctrl+V), then drag the markers onto it so they sit on the right places." },
    { page: "progression-guide", title: "Your character",
      text: "Log in to a character and the guide reads your gear, Daevanion boards and skills from the official site: what to improve first, and a gear score roadmap." },
    { page: "daily-planner", title: "Your routine",
      text: "What to do each day and week, reset at the game's resets, with a reminder before a reset while something is left." },
    { page: "home", title: "Put things where you want them", final: true,
      text: "Edit layout shows everything on the overlay to drag into place; press Done on the screen when finished. Ctrl+Alt+L locks and unlocks everything, and Hide all hides it all. This guide is on Home if you want it again." },
  ];
  let tour = null; // { step }

  function tourSteps() {
    return TOUR.filter((s) => s.page === "home" || s.page === "overlay" || modules.some((m) => m.id === s.page));
  }

  function renderTour() {
    let bar = $(".tour");
    if (!tour) {
      bar?.remove();
      return;
    }
    const steps = tourSteps();
    const i = Math.max(0, Math.min(steps.length - 1, tour.step));
    const step = steps[i];
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "tour";
      bar.setAttribute("role", "region");
      bar.setAttribute("aria-label", "Setup guide");
      $(".top").after(bar);
    }
    bar.innerHTML = `
      <div class="tourHead">
        <span class="tourStep">Setup · ${i + 1} of ${steps.length}</span>
        <span class="tourDots">${steps.map((_, j) => `<i class="${j < i ? "done" : j === i ? "now" : ""}"></i>`).join("")}</span>
        <button type="button" class="tourSkip">Skip setup</button>
      </div>
      <div class="tourBody">
        <div class="tourText"><b>${esc(step.title)}</b><p>${esc(step.text)}</p></div>
        <div class="tourBtns">
          ${i > 0 ? '<button type="button" class="btn tourBack">Back</button>' : ""}
          ${step.final ? '<button type="button" class="btn tourEdit">Edit layout now</button><button type="button" class="btn primary tourDone">Finish</button>'
            : '<button type="button" class="btn primary tourNext">Next</button>'}
        </div>
      </div>`;
    bar.querySelector(".tourSkip").addEventListener("click", () => endTour());
    bar.querySelector(".tourBack")?.addEventListener("click", () => goTour(i - 1));
    bar.querySelector(".tourNext")?.addEventListener("click", () => goTour(i + 1));
    bar.querySelector(".tourDone")?.addEventListener("click", () => endTour());
    bar.querySelector(".tourEdit")?.addEventListener("click", () => {
      invoke("overlay_edit", { editing: true }).catch(() => {});
      endTour();
    });
  }

  function goTour(i) {
    const steps = tourSteps();
    const before = steps[tour?.step ?? -1];
    tour = { step: Math.max(0, Math.min(steps.length - 1, i)) };
    try { localStorage.setItem(TOUR_KEY, JSON.stringify(tour)); } catch {}
    const step = steps[tour.step];
    // Event Timers' Track tab, with its own words, while on that step.
    if (before?.setup && !step.setup) hosts.get(before.page)?.hear({ event: "setup", data: { active: false } });
    show(step.page);
    if (step.setup) hosts.get(step.page)?.hear({ event: "setup", data: { active: true } });
    renderTour();
  }

  function endTour() {
    const steps = tourSteps();
    const step = steps[tour?.step ?? -1];
    if (step?.setup) hosts.get(step.page)?.hear({ event: "setup", data: { active: false } });
    tour = null;
    try { localStorage.setItem(TOUR_KEY, JSON.stringify({ done: true })); } catch {}
    renderTour();
  }

  function startTour() {
    goTour(0);
  }
  window.__startTour = startTour;

  (async () => {
    try { overlay = await invoke("overlay_state"); } catch {}
    renderControls();
    await loadModules();
    let start = window.__DASHBOARD_START__;
    if (!start) try { start = localStorage.getItem("dashboard.page"); } catch {}
    show(start || "home");
    window.lucide?.createIcons?.();
    // First start (or a setup left half done): the guide.
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(TOUR_KEY) || "null"); } catch {}
    if (!saved?.done) setTimeout(() => goTour(saved?.step ?? 0), 400);
  })();
})();
