// The overlay (src-tauri/src/plugins/overlay.rs): the meter's own window,
// over the game's screen, with the DPS meter where the player left it and
// every plugin's widget in a sandboxed frame of its own. Places are kept as
// fractions of the screen.
//
// Locked, nothing moves: the widgets let every click through to the game and
// the meter takes them, or only its title bar's buttons do with its
// click-through on. Unlocked, both take clicks and can be dragged. Editing
// the layout, the whole screen takes the mouse, and each has a handle over it
// to drag it by and a slider for how see-through it is. The window takes the
// mouse only where something here does (`overlay_input`): what is not drawn
// never keeps a click from the game.
(() => {
  if (window.A2_VIEW !== "main") return;
  const { invoke, convertFileSrc } = window.__TAURI__.core;
  const current = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
  const root = document.documentElement;
  const SNAP = 8;
  const SNAP_MIDDLE = 10;
  // A press on the meter moves it once the pointer has gone this far.
  const DRAG_START = 3;
  // An item whose top is nearer the screen's top than this has its edit bar below.
  const BAR_ROOM = 34;
  root.classList.add("a2overlay");

  const add = (tag, cls, parent) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    parent?.append(el);
    return el;
  };
  const grid = add("div", "ovGrid", document.body);
  const guides = add("div", "ovGuides", document.body);
  const guideV = add("div", "ovGuide v", guides);
  const guideH = add("div", "ovGuide h", guides);
  const layer = add("div", "ovLayer", document.body);
  const handles = add("div", "ovHandles", document.body);
  grid.setAttribute("aria-hidden", "true");
  guides.setAttribute("aria-hidden", "true");
  const editBar = add("div", "ovEditBar", document.body);
  editBar.setAttribute("role", "toolbar");
  add("span", "ovEditTitle", editBar).textContent = "Edit layout";
  add("span", "ovEditHint", editBar).textContent =
    "Drag anything to move it; its slider sets how see-through it is. Things snap to the grid and the screen's middle.";
  const resetBtn = add("button", "ovEditBtn", editBar);
  resetBtn.type = "button";
  resetBtn.textContent = "Reset layout";
  const doneBtn = add("button", "ovEditBtn primary", editBar);
  doneBtn.type = "button";
  doneBtn.textContent = "Done";

  const widgets = new Map();
  let state = {
    editing: false,
    hidden: false,
    hiddenPlugins: [],
    locked: {},
    screenshot: false,
    meter: { hidden: false, locked: true, clickThrough: false },
  };
  let language = "en";
  let dragging = null;
  const keyOf = (plugin, name) => `${plugin}\u0000${name}`;
  const base = convertFileSrc("", "a2plugin").replace(/\/*$/, "/");

  const width = () => window.innerWidth || 1;
  const height = () => window.innerHeight || 1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ── Each thing's handle while the layout is edited ──────────────────────
  // A dashed outline over it to drag it by, its name, and a slider for how
  // see-through it is (kept by plugins/overlay.rs, overlay_opacity).
  function makeHandle(item) {
    const handle = add("div", "ovHandle", handles);
    const bar = add("div", "ovHandleBar", handle);
    item.labelEl = add("span", "ovHandleLabel", bar);
    item.labelEl.textContent = labelOf(item);
    const opacity = add("label", "ovOpacity", bar);
    opacity.title = "How see-through it is";
    const slider = add("input", "", opacity);
    Object.assign(slider, { type: "range", min: "10", max: "100", step: "5" });
    slider.setAttribute("aria-label", `${labelOf(item)}: opacity`);
    const value = add("span", "ovOpacityValue", opacity);
    item.slider = slider;
    item.sliderValue = value;
    // The slider is not a handle to drag by.
    opacity.addEventListener("pointerdown", (e) => e.stopPropagation());
    let saveTimer = 0;
    slider.addEventListener("input", () => {
      item.opacity = clamp(Number(slider.value) / 100, 0.1, 1);
      showOpacity(item);
      render(item);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveOpacity(item), 250);
    });
    slider.addEventListener("change", () => {
      clearTimeout(saveTimer);
      saveOpacity(item);
    });
    handle.addEventListener("pointerdown", (e) => startHandleDrag(item, e));
    item.handle = handle;
    showOpacity(item);
    return handle;
  }

  function showOpacity(item) {
    const pct = Math.round(item.opacity * 100);
    if (item.slider && document.activeElement !== item.slider) item.slider.value = String(pct);
    if (item.sliderValue) item.sliderValue.textContent = `${pct}%`;
  }

  function saveOpacity(item) {
    const args = item.kind === "meter"
      ? { plugin: null, name: null, opacity: item.opacity }
      : { plugin: item.plugin, name: item.name, opacity: item.opacity };
    invoke("overlay_opacity", args).catch(() => {});
  }

  // "Combat Alerts · Loss of control": the plugin, and the widget's label
  // when it gave one.
  function labelOf(item) {
    return item.label ? `${item.title} · ${item.label}` : item.title;
  }

  // Its handle and edit bar over the part of it that shows, or all of it.
  function placeHandle(item, left, top, w, h) {
    const a = item.area && item.area.width > 1 && item.area.height > 1 ? item.area : { x: 0, y: 0, width: w, height: h };
    Object.assign(item.handle.style, {
      left: `${left + a.x}px`,
      top: `${top + a.y}px`,
      width: `${a.width}px`,
      height: `${a.height}px`,
    });
    item.handle.classList.toggle("barBelow", top + a.y < BAR_ROOM);
    item.handle.classList.toggle("hidden", item.kind === "meter" ? meterHidden() : hiddenNow(item));
  }

  // ── The meter ──────────────────────────────────────────────────────────
  // index.html's .container, laid over the screen like a widget, but drawn
  // by this page rather than in a frame. Its size is its content's.
  const meter = {
    kind: "meter",
    title: "DPS Meter",
    label: "",
    x: 0.015,
    y: 0.1,
    opacity: 1,
    area: null,
    box: document.querySelector(".container"),
  };
  const meterEl = () => meter.box?.querySelector(":scope > .meter");
  meter.width = () => meterEl()?.offsetWidth || 0;
  meter.height = () => meterEl()?.offsetHeight || 0;
  if (meter.box) makeHandle(meter);

  const meterHidden = () => !!state.meter?.hidden;
  const meterMovable = () => !!state.editing || !state.meter?.locked;

  function renderMeter() {
    if (!meter.box) return;
    const { left, top } = pixels(meter);
    const l = `${left}px`;
    const t = `${top}px`;
    if (meter.box.style.left !== l) meter.box.style.left = l;
    if (meter.box.style.top !== t) meter.box.style.top = t;
    meter.box.style.opacity = String(meter.opacity);
    root.classList.toggle("meterOff", meterHidden());
    root.classList.toggle("meterLocked", !meterMovable());
    root.classList.toggle("meterClickThrough", !!state.meter?.clickThrough && !state.editing);
    const r = meterEl()?.getBoundingClientRect();
    if (r) placeHandle(meter, r.left, r.top, r.width, r.height);
  }

  // The parts of the meter's page that take the mouse, as [x, y, width,
  // height]: a card it shows (an update, a one-time offer) whatever else,
  // the meter hidden or not; with its click-through on, its title bar's
  // buttons alone; at rest (nothing to show, or out of combat), its two
  // pills; else all of it, and a panel it has open.
  function meterRects() {
    if (state.screenshot) return [];
    const rects = [];
    const take = (el) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push([r.left, r.top, r.width, r.height]);
    };
    document.querySelectorAll(
      ".updateModal.isOpen .updateModalCard, .discordPromo.isOpen .discordPromoCard, .supportModal.isOpen .supportModalCard",
    ).forEach(take);
    if (!meter.box || meterHidden()) return rects;
    const m = meterEl();
    if (!m) return rects;
    if (state.meter?.clickThrough) {
      take(m.querySelector(".headerBtns"));
      return rects;
    }
    if (m.matches(".isIdle, .isResting")) {
      take(m.querySelector(".bossIcon"));
      take(m.querySelector(".headerBtns"));
    } else {
      take(m);
    }
    meter.box.querySelectorAll(":scope > .detailsPanel.open, :scope > .settingsPanel.isOpen, :scope > .historyPanel.open, :scope > .historyPanel.isOpen")
      .forEach(take);
    return rects;
  }

  // The meter changed (rows, a panel, a card, its size): laid out again, and
  // where it takes the mouse said again if that moved. Many callers, so once
  // a frame.
  let meterQueued = false;
  function meterChanged() {
    if (meterQueued) return;
    meterQueued = true;
    requestAnimationFrame(() => {
      meterQueued = false;
      renderMeter();
      scheduleInput();
    });
  }

  // A press on the meter's title bar, footer or any empty part of it
  // (tauriBridge.js): it drags the meter once the pointer moves, unless the
  // meter is locked. True if it may become a drag.
  function pressMeter(e) {
    if (!meter.box || e.button !== 0 || !meterMovable() || dragging) return false;
    const press = { x: e.clientX, y: e.clientY };
    const move = (ev) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - press.x) + Math.abs(ev.clientY - press.y) < DRAG_START) return;
        if (!(ev.buttons & 1)) return end();
        beginDrag(meter, press.x, press.y);
      }
      moveDrag(ev.clientX, ev.clientY);
    };
    const end = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", end, true);
      window.removeEventListener("blur", end);
      if (dragging?.item === meter) endDrag();
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", end, true);
    window.addEventListener("blur", end);
    return true;
  }

  // ── A widget's frame and what it may ask ───────────────────────────────
  function make(spec) {
    const w = {
      kind: "widget",
      plugin: spec.plugin,
      name: spec.name,
      title: spec.title || spec.plugin,
      label: spec.label || "",
      clickable: !!spec.clickable,
      w: spec.width,
      h: spec.height,
      x: spec.x,
      y: spec.y,
      opacity: Number.isFinite(spec.opacity) ? clamp(spec.opacity, 0.1, 1) : 1,
      area: null,
      ready: false,
      queue: [],
      box: document.createElement("div"),
      frame: document.createElement("iframe"),
    };
    w.width = () => w.w;
    w.height = () => w.h;
    w.box.className = "ovWidget";
    w.frame.setAttribute("sandbox", "allow-scripts");
    w.frame.setAttribute("referrerpolicy", "no-referrer");
    w.frame.setAttribute("allowtransparency", "true");
    w.frame.src = `${base}${encodeURIComponent(w.plugin)}/widget.html?name=${encodeURIComponent(w.name)}`;
    w.box.append(w.frame);
    layer.append(w.box);
    makeHandle(w);
    widgets.set(keyOf(w.plugin, w.name), w);
    deliver(w, "language", language);
    deliver(w, "locked", !interactive(w));
    if (spec.last != null) deliver(w, "widget", spec.last);
    render(w);
    return w;
  }

  function send(w, msg) {
    w.frame.contentWindow?.postMessage({ a2: 1, ...msg }, "*");
  }

  function deliver(w, event, data) {
    if (w.ready) send(w, { event, data });
    else w.queue.push({ event, data });
  }

  const calls = {
    ready(w) {
      w.ready = true;
      for (const m of w.queue.splice(0)) send(w, m);
      return true;
    },
    // A press inside the widget that became a drag (a2.widget.drag): the
    // frame reports the pointer's screen position until it is let go.
    "widget.drag"(w, [sx, sy]) {
      if (!interactive(w) || !Number.isFinite(sx) || !Number.isFinite(sy)) return false;
      beginDrag(w, sx, sy);
      return true;
    },
    "widget.dragMove"(w, [sx, sy]) {
      if (dragging?.item === w && Number.isFinite(sx) && Number.isFinite(sy)) moveDrag(sx, sy);
      return true;
    },
    "widget.dragEnd"(w) {
      if (dragging?.item === w) endDrag();
      return true;
    },
    // The part of the frame that takes the mouse, in its CSS px.
    "widget.area"(w, [r]) {
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      w.area = { x: n(r?.x), y: n(r?.y), width: n(r?.width), height: n(r?.height) };
      render(w);
      return true;
    },
    "widget.post"(w, [data]) {
      return invoke("overlay_post", { plugin: w.plugin, name: w.name, data: data ?? null });
    },
  };

  window.addEventListener("message", async (event) => {
    const msg = event.data;
    if (!msg || msg.a2 !== 1 || !msg.id || typeof msg.call !== "string") return;
    const w = [...widgets.values()].find((x) => x.frame.contentWindow === event.source);
    if (!w) return;
    const fn = calls[msg.call];
    try {
      if (!fn) throw new Error(`unknown call ${msg.call}`);
      send(w, { id: msg.id, result: await fn(w, Array.isArray(msg.args) ? msg.args : []) });
    } catch (e) {
      send(w, { id: msg.id, error: String(e?.message || e) });
    }
  });

  // ── Where each widget is, and what takes the mouse ─────────────────────
  function hiddenNow(w) {
    return state.hidden || (state.hiddenPlugins || []).includes(w.plugin);
  }

  function interactive(w) {
    return state.editing || (!state.screenshot && state.locked?.[w.plugin] === false);
  }

  // Takes the mouse: unlocked, or a widget that is always clickable (it
  // still moves only while unlocked).
  const takesClicks = (w) => interactive(w) || (w.clickable && !state.screenshot);

  // Its top left in CSS px, kept on screen.
  function pixels(item) {
    const left = Math.round(Math.max(0, Math.min(width() - item.width(), item.x * width())));
    const top = Math.round(Math.max(0, Math.min(height() - item.height(), item.y * height())));
    return { left, top };
  }

  function render(item) {
    if (item.kind === "meter") {
      renderMeter();
      scheduleInput();
      return;
    }
    const w = item;
    const { left, top } = pixels(w);
    w.box.style.transform = `translate(${left}px, ${top}px)`;
    w.box.style.width = `${w.w}px`;
    w.box.style.height = `${w.h}px`;
    w.box.style.opacity = String(w.opacity);
    w.box.classList.toggle("hidden", hiddenNow(w));
    placeHandle(w, left, top, w.w, w.h);
    scheduleInput();
  }

  function renderAll() {
    root.classList.toggle("ovEditing", !!state.editing);
    for (const w of widgets.values()) {
      render(w);
      deliver(w, "locked", !interactive(w));
    }
    renderMeter();
    scheduleInput();
  }

  let inputQueued = false;
  let lastInput = "";
  function scheduleInput() {
    if (inputQueued) return;
    inputQueued = true;
    requestAnimationFrame(() => {
      inputQueued = false;
      const all = !!state.editing || !!dragging;
      const rects = [];
      if (!all) {
        for (const w of widgets.values()) {
          if (hiddenNow(w) || !takesClicks(w)) continue;
          const { left, top } = pixels(w);
          const a = w.area && w.area.width > 1 && w.area.height > 1 ? w.area : { x: 0, y: 0, width: w.w, height: w.h };
          rects.push([left + a.x, top + a.y, a.width, a.height]);
        }
        rects.push(...meterRects());
      }
      const m = meterEl();
      const box = m && !meterHidden() ? m.getBoundingClientRect() : null;
      const shown = box && box.width > 0 && box.height > 0 ? [box.left, box.top, box.width, box.height] : null;
      const round = (r) => r.map((v) => Math.round(v * 2) / 2);
      const key = JSON.stringify([all, rects.map(round), shown && round(shown)]);
      if (key === lastInput) return;
      lastInput = key;
      invoke("overlay_input", { rects, all, meter: shown }).catch(() => {
        lastInput = "";
      });
    });
  }

  // ── Dragging ───────────────────────────────────────────────────────────
  function beginDrag(item, sx, sy) {
    const { left, top } = pixels(item);
    dragging = { item, sx, sy, left, top };
    if (item.kind !== "meter") item.box.classList.add("dragging");
    item.handle.classList.add("dragging");
    root.classList.add("ovDragging");
    scheduleInput();
  }

  // Snapped to the grid, and to the screen's middle when near it.
  function moveDrag(sx, sy) {
    const d = dragging;
    const item = d.item;
    const w = item.width();
    const h = item.height();
    let left = d.left + (sx - d.sx);
    let top = d.top + (sy - d.sy);
    const midX = (width() - w) / 2;
    const midY = (height() - h) / 2;
    const onV = Math.abs(left - midX) <= SNAP_MIDDLE;
    const onH = Math.abs(top - midY) <= SNAP_MIDDLE;
    left = onV ? midX : Math.round(left / SNAP) * SNAP;
    top = onH ? midY : Math.round(top / SNAP) * SNAP;
    guideV.classList.toggle("on", onV);
    guideH.classList.toggle("on", onH);
    item.x = Math.max(0, Math.min(width() - w, left)) / width();
    item.y = Math.max(0, Math.min(height() - h, top)) / height();
    render(item);
  }

  function endDrag() {
    const { item } = dragging;
    dragging = null;
    if (item.kind !== "meter") item.box.classList.remove("dragging");
    item.handle.classList.remove("dragging");
    root.classList.remove("ovDragging");
    guideV.classList.remove("on");
    guideH.classList.remove("on");
    if (item.kind === "meter") {
      invoke("overlay_meter_moved", { x: item.x, y: item.y }).catch(() => {});
    } else {
      invoke("overlay_moved", { plugin: item.plugin, name: item.name, x: item.x, y: item.y }).catch(() => {});
    }
    scheduleInput();
  }

  // Editing: the handle over each one is what is dragged.
  function startHandleDrag(item, e) {
    if (!state.editing || e.button !== 0) return;
    e.preventDefault();
    item.handle.setPointerCapture(e.pointerId);
    beginDrag(item, e.clientX, e.clientY);
    const move = (ev) => moveDrag(ev.clientX, ev.clientY);
    const up = () => {
      item.handle.removeEventListener("pointermove", move);
      item.handle.removeEventListener("pointerup", up);
      item.handle.removeEventListener("pointercancel", up);
      if (dragging) endDrag();
    };
    item.handle.addEventListener("pointermove", move);
    item.handle.addEventListener("pointerup", up);
    item.handle.addEventListener("pointercancel", up);
  }

  doneBtn.addEventListener("click", () => invoke("overlay_edit", { editing: false }).catch(() => {}));
  resetBtn.addEventListener("click", () => invoke("overlay_reset_layout").catch(() => {}));

  // ── What the app says ──────────────────────────────────────────────────
  function apply(op) {
    if (op.op === "state") {
      state = { ...op, meter: { ...state.meter, ...(op.meter || {}) } };
      renderAll();
      return;
    }
    if (op.op === "meter") {
      if (Number.isFinite(op.x) && Number.isFinite(op.y) && dragging?.item !== meter) {
        meter.x = op.x;
        meter.y = op.y;
        renderMeter();
        scheduleInput();
      }
      return;
    }
    const key = keyOf(op.plugin, op.name);
    const w = widgets.get(key);
    switch (op.op) {
      case "open":
        if (w) {
          w.w = op.width;
          w.h = op.height;
          w.x = op.x;
          w.y = op.y;
          w.label = op.label || w.label;
          w.clickable = !!op.clickable;
          w.labelEl.textContent = labelOf(w);
          render(w);
        } else {
          make(op);
        }
        break;
      case "close":
        if (w) {
          if (dragging?.item === w) dragging = null;
          w.box.remove();
          w.handle.remove();
          widgets.delete(key);
          scheduleInput();
        }
        break;
      case "send":
        if (w) deliver(w, "widget", op.data);
        break;
      case "place":
        if (w && dragging?.item !== w) {
          w.x = op.x;
          w.y = op.y;
          render(w);
        }
        break;
    }
  }

  current.listen("overlay", (event) => apply(event.payload || {}));
  current.listen("plugin-event", (event) => {
    const p = event.payload || {};
    if (p.event === "language" && typeof p.data === "string") {
      language = p.data;
      for (const w of widgets.values()) deliver(w, "language", language);
    }
  });

  function reportMetrics() {
    invoke("overlay_metrics", { width: width(), height: height(), scale: window.devicePixelRatio || 1 }).catch(() => {});
  }
  window.addEventListener("resize", () => {
    reportMetrics();
    for (const w of widgets.values()) render(w);
    meterChanged();
  });

  // The meter's size follows its rows, panels and settings; its place is
  // kept on screen as it grows.
  if (typeof ResizeObserver === "function" && meter.box) {
    const ro = new ResizeObserver(() => meterChanged());
    ro.observe(meter.box);
    const m = meterEl();
    if (m) ro.observe(m);
  }
  // A card opening or closing (an update, a one-time offer) takes or gives
  // back the mouse there at once.
  if (typeof MutationObserver === "function") {
    const cards = new MutationObserver(() => meterChanged());
    document.querySelectorAll(".updateModal, .discordPromo, .supportModal")
      .forEach((card) => cards.observe(card, { attributes: true, attributeFilter: ["class"] }));
  }

  window.a2Overlay = Object.freeze({ meterChanged, pressMeter });

  reportMetrics();
  renderMeter();
  invoke("overlay_hello")
    .then((hello) => {
      language = hello.language || "en";
      if (hello.state) state = { ...hello.state, meter: { ...state.meter, ...(hello.state.meter || {}) } };
      const m = hello.meter || {};
      if (Number.isFinite(m.x) && Number.isFinite(m.y)) {
        meter.x = m.x;
        meter.y = m.y;
      }
      if (Number.isFinite(m.opacity)) meter.opacity = clamp(m.opacity, 0.1, 1);
      if (meter.handle) showOpacity(meter);
      for (const spec of hello.widgets || []) if (!widgets.has(keyOf(spec.plugin, spec.name))) make(spec);
      renderAll();
    })
    .catch(() => {});
})();
