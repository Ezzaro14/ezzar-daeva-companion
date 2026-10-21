// The one overlay (src-tauri/src/plugins/overlay.rs): every plugin's widget
// in a sandboxed frame of its own, over the game's screen. Places are kept as
// fractions of the screen. Locked, every click goes through to the game;
// unlocked, the widgets take clicks; editing the layout, the whole screen
// takes the mouse and each widget can be dragged by a handle over it.
(() => {
  const { invoke, convertFileSrc } = window.__TAURI__.core;
  const current = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
  const layer = document.querySelector(".layer");
  const SNAP = 8;
  const SNAP_MIDDLE = 10;

  const widgets = new Map();
  let state = { editing: false, hidden: false, hiddenPlugins: [], locked: {}, screenshot: false };
  let language = "en";
  let dragging = null;
  const keyOf = (plugin, name) => `${plugin}\u0000${name}`;
  const base = convertFileSrc("", "a2plugin").replace(/\/*$/, "/");

  const width = () => window.innerWidth || 1;
  const height = () => window.innerHeight || 1;

  // ── A widget's frame and what it may ask ───────────────────────────────
  function make(spec) {
    const w = {
      plugin: spec.plugin,
      name: spec.name,
      title: spec.title || spec.plugin,
      label: spec.label || "",
      clickable: !!spec.clickable,
      width: spec.width,
      height: spec.height,
      x: spec.x,
      y: spec.y,
      area: null,
      ready: false,
      queue: [],
      box: document.createElement("div"),
      frame: document.createElement("iframe"),
      handle: document.createElement("div"),
    };
    w.box.className = "widget";
    w.frame.setAttribute("sandbox", "allow-scripts");
    w.frame.setAttribute("referrerpolicy", "no-referrer");
    w.frame.setAttribute("allowtransparency", "true");
    w.frame.src = `${base}${encodeURIComponent(w.plugin)}/widget.html?name=${encodeURIComponent(w.name)}`;
    w.handle.className = "handle";
    const label = document.createElement("span");
    label.className = "handleLabel";
    label.textContent = labelOf(w);
    w.handle.append(label);
    w.handle.addEventListener("pointerdown", (e) => startHandleDrag(w, e));
    w.box.append(w.frame, w.handle);
    layer.append(w.box);
    widgets.set(keyOf(w.plugin, w.name), w);
    deliver(w, "language", language);
    deliver(w, "locked", !interactive(w));
    if (spec.last != null) deliver(w, "widget", spec.last);
    render(w);
    return w;
  }

  // "Combat Alerts · Loss of control": the plugin, and the widget's label
  // when it gave one.
  function labelOf(w) {
    return w.label ? `${w.title} · ${w.label}` : w.title;
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
      if (dragging?.w === w && Number.isFinite(sx) && Number.isFinite(sy)) moveDrag(sx, sy);
      return true;
    },
    "widget.dragEnd"(w) {
      if (dragging?.w === w) endDrag();
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
  function pixels(w) {
    const left = Math.round(Math.max(0, Math.min(width() - w.width, w.x * width())));
    const top = Math.round(Math.max(0, Math.min(height() - w.height, w.y * height())));
    return { left, top };
  }

  function render(w) {
    const { left, top } = pixels(w);
    w.box.style.transform = `translate(${left}px, ${top}px)`;
    w.box.style.width = `${w.width}px`;
    w.box.style.height = `${w.height}px`;
    w.box.classList.toggle("hidden", hiddenNow(w));
    // The handle covers the part that shows, or the whole frame.
    const a = w.area && w.area.width > 1 && w.area.height > 1 ? w.area : { x: 0, y: 0, width: w.width, height: w.height };
    Object.assign(w.handle.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.width}px`, height: `${a.height}px` });
    scheduleInput();
  }

  function renderAll() {
    document.body.classList.toggle("editing", !!state.editing);
    for (const w of widgets.values()) {
      render(w);
      deliver(w, "locked", !interactive(w));
    }
  }

  let inputQueued = false;
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
          const a = w.area && w.area.width > 1 && w.area.height > 1 ? w.area : { x: 0, y: 0, width: w.width, height: w.height };
          rects.push([left + a.x, top + a.y, a.width, a.height]);
        }
      }
      invoke("overlay_input", { rects, all }).catch(() => {});
    });
  }

  // ── Dragging ───────────────────────────────────────────────────────────
  const guideV = document.querySelector(".guide.v");
  const guideH = document.querySelector(".guide.h");

  function beginDrag(w, sx, sy) {
    const { left, top } = pixels(w);
    dragging = { w, sx, sy, left, top };
    w.box.classList.add("dragging");
    document.body.classList.add("dragging");
    scheduleInput();
  }

  // Snapped to the grid, and to the screen's middle when near it.
  function moveDrag(sx, sy) {
    const d = dragging;
    let left = d.left + (sx - d.sx);
    let top = d.top + (sy - d.sy);
    const midX = (width() - d.w.width) / 2;
    const midY = (height() - d.w.height) / 2;
    const onV = Math.abs(left - midX) <= SNAP_MIDDLE;
    const onH = Math.abs(top - midY) <= SNAP_MIDDLE;
    left = onV ? midX : Math.round(left / SNAP) * SNAP;
    top = onH ? midY : Math.round(top / SNAP) * SNAP;
    guideV.classList.toggle("on", onV);
    guideH.classList.toggle("on", onH);
    d.w.x = Math.max(0, Math.min(width() - d.w.width, left)) / width();
    d.w.y = Math.max(0, Math.min(height() - d.w.height, top)) / height();
    render(d.w);
  }

  function endDrag() {
    const { w } = dragging;
    dragging = null;
    w.box.classList.remove("dragging");
    document.body.classList.remove("dragging");
    guideV.classList.remove("on");
    guideH.classList.remove("on");
    invoke("overlay_moved", { plugin: w.plugin, name: w.name, x: w.x, y: w.y }).catch(() => {});
    scheduleInput();
  }

  // Editing: the handle over each widget is what is dragged.
  function startHandleDrag(w, e) {
    if (!state.editing || e.button !== 0) return;
    e.preventDefault();
    w.handle.setPointerCapture(e.pointerId);
    beginDrag(w, e.screenX, e.screenY);
    const move = (ev) => moveDrag(ev.screenX, ev.screenY);
    const up = () => {
      w.handle.removeEventListener("pointermove", move);
      w.handle.removeEventListener("pointerup", up);
      w.handle.removeEventListener("pointercancel", up);
      if (dragging) endDrag();
    };
    w.handle.addEventListener("pointermove", move);
    w.handle.addEventListener("pointerup", up);
    w.handle.addEventListener("pointercancel", up);
  }

  document.querySelector(".done").addEventListener("click", () => invoke("overlay_edit", { editing: false }).catch(() => {}));
  document.querySelector(".reset").addEventListener("click", () => invoke("overlay_reset_layout").catch(() => {}));

  // ── What the app says ──────────────────────────────────────────────────
  function apply(op) {
    const key = keyOf(op.plugin, op.name);
    const w = widgets.get(key);
    switch (op.op) {
      case "open":
        if (w) {
          w.width = op.width;
          w.height = op.height;
          w.x = op.x;
          w.y = op.y;
          w.label = op.label || w.label;
          w.clickable = !!op.clickable;
          w.handle.querySelector(".handleLabel").textContent = labelOf(w);
          render(w);
        } else {
          make(op);
        }
        break;
      case "close":
        if (w) {
          if (dragging?.w === w) dragging = null;
          w.box.remove();
          widgets.delete(key);
          scheduleInput();
        }
        break;
      case "send":
        if (w) deliver(w, "widget", op.data);
        break;
      case "place":
        if (w && dragging?.w !== w) {
          w.x = op.x;
          w.y = op.y;
          render(w);
        }
        break;
      case "state":
        state = op;
        renderAll();
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
  });

  reportMetrics();
  invoke("overlay_hello")
    .then((hello) => {
      language = hello.language || "en";
      state = hello.state || state;
      for (const spec of hello.widgets || []) if (!widgets.has(keyOf(spec.plugin, spec.name))) make(spec);
      renderAll();
    })
    .catch(() => {});
})();
