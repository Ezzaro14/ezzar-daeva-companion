// Pet Soul Tracker's map, drawn on a canvas: the same in the window's
// "Around you" and in the pop-out (widget.html), which gets what to draw from
// the window as a scene:
//   { mapId, you: { pos, at, estimated } or null, wanted: [{ pos, colour }],
//     others: [pos] (drawn grey), spawnColours: { npcId: colour },
//     labels: { compass: [N, E, S, W], noMapYet, noPicture } in the meter's language }
// The page needs maps.js and the map pictures as <img class="mapPic" loading="lazy">.
(() => {
  // Metres per screen pixel, zoomed in to out.
  const ZOOMS = [0.5, 1, 2, 4, 8, 16];
  // Older than this, your marker fades.
  const STALE_MS = 15_000;

  class MiniMap {
    // els: { canvas, zoomIn, zoomOut, follow, note }; onZoom(zoom) when the
    // zoom changes, to keep it.
    constructor(els, { zoom = 2, onZoom = () => {} } = {}) {
      this.els = els;
      this.zoom = ZOOMS.includes(Number(zoom)) ? Number(zoom) : 2;
      this.onZoom = onZoom;
      this.scene = { mapId: null, you: null, wanted: [], others: [], spawnColours: {}, labels: {} };
      // Where it looks: following you (or the monsters in range, or the
      // map's middle) until it is dragged.
      this.follow = true;
      this.center = null;
      this.glideFrame = 0;
      this.glideAt = 0;
      this.decoded = { id: null, bitmap: null, pending: null };
      this.#listen();
    }
    set(scene) {
      this.scene = { ...this.scene, ...scene };
      this.draw();
    }
    // The map not shown (its option turned off): its pictures let go of, the
    // decoded one (16 MB) and the webview's copy of each picture loaded. A
    // picture's source is kept aside and put back when it is wanted again.
    release() {
      const decoded = this.decoded;
      decoded.bitmap?.close?.();
      Object.assign(decoded, { id: null, bitmap: null, pending: null });
      for (const img of document.querySelectorAll("img.mapPic")) {
        if (img.loading !== "eager" || !img.getAttribute("src")) continue;
        img.dataset.src = img.getAttribute("src");
        img.removeAttribute("src");
        img.loading = "lazy";
      }
    }
    setZoom(zoom) {
      if (!ZOOMS.includes(Number(zoom)) || Number(zoom) === this.zoom) return;
      this.zoom = Number(zoom);
      this.draw();
    }
    #step(step) {
      const i = ZOOMS.indexOf(this.zoom);
      this.zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + step))];
      this.onZoom(this.zoom);
      this.draw();
    }
    // Dragging moves the map (it stops following you until ⌖ or a
    // double-click); the wheel and + / − zoom.
    #listen() {
      const { canvas, zoomIn, zoomOut, follow } = this.els;
      let drag = null;
      canvas.addEventListener("pointerdown", (e) => {
        drag = { x: e.clientX, y: e.clientY, center: [...(this.center || [0, 0])], moved: false };
        canvas.setPointerCapture(e.pointerId);
      });
      // The capture is let go of with the button: a release that never
      // reached the page (the game or a window drag took the mouse) left the
      // map holding every press, so the pop-out's bar no longer moved it.
      const end = (e) => {
        drag = null;
        if (e?.pointerId != null && canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      };
      canvas.addEventListener("pointermove", (e) => {
        if (!drag) return;
        if (!(e.buttons & 1)) return end(e);
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 3) return;
        drag.moved = true;
        this.follow = false;
        this.center = [drag.center[0] - dx * this.zoom * 100, drag.center[1] - dy * this.zoom * 100];
        this.draw();
      });
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);
      canvas.addEventListener("lostpointercapture", () => { drag = null; });
      window.addEventListener("blur", () => { drag = null; });
      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.#step(e.deltaY > 0 ? 1 : -1);
      }, { passive: false });
      const back = () => {
        this.follow = true;
        this.draw();
      };
      canvas.addEventListener("dblclick", back);
      zoomIn?.addEventListener("click", () => this.#step(-1));
      zoomOut?.addEventListener("click", () => this.#step(1));
      follow?.addEventListener("click", back);
      window.addEventListener("resize", () => this.draw());
    }

    // The pictures are <img> tags in the page (the build writes them): on
    // Linux the meter inlines the files a page names and refuses any it asks
    // for later. They are lazy, so only the map you are on is loaded and
    // decoded: asked for here (WebKitGTK and Chromium both leave a hidden
    // lazy picture alone until then, an inlined one too). The webview drops
    // the decoded pixels of an image not on screen, and a canvas drawing it
    // then got nothing until it was decoded again (a grey moment), so the
    // map shown is kept decoded, as an ImageBitmap (one at a time: 16 MB each).
    #picture(id) {
      const img = PET_MAPS[id] && document.querySelector(`img.mapPic[data-map="${Number(id)}"]`);
      if (!img) return null;
      if (img.loading === "lazy") img.loading = "eager";
      // Let go of while the map was off (release): loaded again.
      if (!img.getAttribute("src") && img.dataset.src) img.setAttribute("src", img.dataset.src);
      const decoded = this.decoded;
      if (decoded.id === id && decoded.bitmap) return decoded.bitmap;
      if (decoded.pending !== id && typeof createImageBitmap === "function") {
        decoded.pending = id;
        const loaded = img.complete ? Promise.resolve() : new Promise((done) => img.addEventListener("load", done, { once: true }));
        loaded.then(() => createImageBitmap(img)).then((bitmap) => {
          if (decoded.pending !== id) return bitmap.close();
          decoded.bitmap?.close?.();
          Object.assign(decoded, { id, bitmap, pending: null });
          this.draw();
        }).catch(() => {
          if (decoded.pending === id) Object.assign(decoded, { id, bitmap: img, pending: null });
        });
      }
      if (img.complete && img.naturalWidth) return img;
      img.addEventListener("load", () => this.draw(), { once: true });
      return null;
    }

    // Following you, the map glides to each new position rather than
    // jumping (a teleport or a new map jumps): most of the way in about half
    // a second.
    #glideTo(target) {
      const now = performance.now();
      const from = this.center;
      if (!from || Math.hypot(target[0] - from[0], target[1] - from[1]) > 50_000) {
        this.center = [target[0], target[1]];
      } else {
        const k = 1 - Math.exp(-Math.min(200, now - (this.glideAt || now)) / 150);
        this.center = [from[0] + (target[0] - from[0]) * k, from[1] + (target[1] - from[1]) * k];
        // Not there yet (more than half a pixel): another frame.
        if (Math.hypot(target[0] - this.center[0], target[1] - this.center[1]) > this.zoom * 50 && !this.glideFrame) {
          this.glideFrame = requestAnimationFrame(() => {
            this.glideFrame = 0;
            this.draw();
          });
        }
      }
      this.glideAt = now;
    }

    // North up: the map's picture, the spawns of the monsters you need (small
    // dots in their pet's genus colour), the monsters in range on them
    // (large, ringed; others grey), and you (faded while your position is
    // old, a dashed circle while estimated).
    draw() {
      const { canvas, follow, note } = this.els;
      if (!canvas.isConnected || canvas.closest("[hidden]")) return;
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 220;
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
        canvas.width = Math.round(w * ratio);
        canvas.height = Math.round(h * ratio);
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = "#1a1f29";
      ctx.fillRect(0, 0, w, h);
      const { mapId: id, you, wanted, others, spawnColours, labels = {} } = this.scene;
      const info = PET_MAPS[id];
      if (this.follow || !this.center) {
        const live = wanted.length ? wanted.map((n) => n.pos) : others;
        const target = you?.pos
          || (live.length ? [live.reduce((a, p) => a + p[0], 0) / live.length, live.reduce((a, p) => a + p[1], 0) / live.length] : null)
          || (info ? [(info.bounds[0] + info.bounds[2]) / 2, (info.bounds[1] + info.bounds[3]) / 2] : [0, 0]);
        this.#glideTo(target);
      }
      const [cx, cy] = this.center;
      const zoom = this.zoom;
      const cmPerPx = zoom * 100;
      const at = (x, y) => [w / 2 + (x - cx) / cmPerPx, h / 2 + (y - cy) / cmPerPx];
      const onScreen = ([x, y]) => x > -8 && y > -8 && x < w + 8 && y < h + 8;

      const picture = this.#picture(id);
      if (picture) {
        const [minX, minY, maxX, maxY] = info.bounds;
        const [x0, y0] = at(minX, minY);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(picture, x0, y0, (maxX - minX) / cmPerPx, (maxY - minY) / cmPerPx);
      }
      if (note) {
        note.hidden = !!picture;
        note.textContent = !id
          ? labels.noMapYet || "The map shows after your next teleport or zone change"
          : info ? "" : labels.noPicture || "No map picture for this place";
      }

      const dot = ([x, y], r, fill, stroke, width = 1) => {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
          ctx.lineWidth = width;
          ctx.strokeStyle = stroke;
          ctx.stroke();
        }
      };
      // The spawns, smaller as the map zooms out.
      const r = zoom <= 2 ? 3 : zoom <= 4 ? 2.4 : 1.8;
      for (const [npc, points] of Object.entries(PET_SPAWNS[id] || {})) {
        const colour = spawnColours[npc];
        if (!colour) continue;
        for (let i = 0; i < points.length; i += 2) {
          const p = at(points[i] * 100, points[i + 1] * 100);
          if (onScreen(p)) dot(p, r, colour, "rgba(20, 14, 6, 0.75)");
        }
      }
      for (const pos of others) dot(at(pos[0], pos[1]), 3, "rgba(160, 160, 160, 0.85)", "rgba(0, 0, 0, 0.6)");
      // The nearest drawn last, on top.
      for (const n of [...wanted].reverse()) dot(at(n.pos[0], n.pos[1]), 5, n.colour, "#fff", 1.5);

      if (you) {
        const p = at(you.pos[0], you.pos[1]);
        ctx.globalAlpha = !you.estimated && Date.now() - you.at > STALE_MS ? 0.5 : 1;
        // Estimated: a dashed circle as wide as its error, about 25 m.
        if (you.estimated) {
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.arc(p[0], p[1], Math.max(18, 25 / zoom), 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255, 224, 102, 0.12)";
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "rgba(255, 224, 102, 0.85)";
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // A dark ring with a white edge and a bright middle: unlike any spawn.
        dot(p, 12, "rgba(255, 255, 255, 0.18)");
        dot(p, 7, "#14161e", "#fff", 2);
        dot(p, 3, "#ffe066");
        ctx.globalAlpha = 1;
      }

      // The compass and the scale.
      ctx.font = "700 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const [north, east, south, west] = labels.compass?.length === 4 ? labels.compass : ["N", "E", "S", "W"];
      for (const [label, x, y] of [[north, w / 2, 9], [south, w / 2, h - 9], [west, 9, h / 2], [east, w - 9, h / 2]]) {
        dot([x, y], 7.5, "rgba(20, 22, 30, 0.75)");
        ctx.fillStyle = "#e8e2d0";
        ctx.fillText(label, x, y + 0.5);
      }
      const metres = [10, 20, 50, 100, 200, 500, 1000, 2000].find((m) => m / zoom >= 50) || 2000;
      const len = metres / zoom;
      ctx.fillStyle = "rgba(20, 22, 30, 0.75)";
      ctx.fillRect(6, h - 22, len + 8, 16);
      ctx.strokeStyle = "#e8e2d0";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(10, h - 10);
      ctx.lineTo(10 + len, h - 10);
      ctx.stroke();
      ctx.fillStyle = "#e8e2d0";
      ctx.font = "600 9px system-ui, sans-serif";
      ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, 10 + len / 2, h - 16);
      if (follow) follow.hidden = this.follow;
    }
  }

  globalThis.PetMiniMap = { ZOOMS, STALE_MS, MiniMap };
})();
