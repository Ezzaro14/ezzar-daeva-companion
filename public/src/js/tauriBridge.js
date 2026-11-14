/**
 * Tauri 2 bridge adapter.
 * Creates window.javaBridge and window.dpsData compatibility objects
 * that translate the old JavaFX bridge calls to Tauri 2 IPC.
 */
(function () {
  "use strict";

  const { invoke } = window.__TAURI__.core;

  // Which optional parts this build has (app.rs build_features). The private
  // build, compiled without online features, has no shared boss timers, update
  // check or stream overlay: html.a2-offline
  // hides them (styles.css) and the code below skips them.
  window.a2Build = { online: true };
  window.a2BuildReady = invoke("build_features")
    .then((features) => {
      window.a2Build = { online: features?.online !== false };
      document.documentElement.classList.toggle("a2-offline", !window.a2Build.online);
      return window.a2Build;
    })
    .catch(() => window.a2Build);
  const { listen } = window.__TAURI__.event;
  const { open: shellOpen } = window.__TAURI__.opener;

  // The backend enables compositor resizing on GNOME and KDE.
  const isLinux = document.documentElement.classList.contains("linux");

  // WebKitGTK can show a row as hovered when the window opens or comes back,
  // from where the pointer was before, until the pointer moves over it again
  // (Linux players, 2026-10-17). Row hover waits for a real move: one that
  // moved (a synthetic event does not).
  const staleHover = () => { if (isLinux) document.documentElement.classList.add("hoverStale"); };
  staleHover();
  document.addEventListener("mousemove", (e) => {
    if ((e.movementX || e.movementY) && document.documentElement.classList.contains("hoverStale")) {
      document.documentElement.classList.remove("hoverStale");
    }
  }, { capture: true, passive: true });
  // Native startup policy is independent of the webview's user agent.
  const loadsHidden = window.__A2_WINDOW_STARTUP__?.loadsHidden === true;
  const reusesSettings = window.__A2_WINDOW_STARTUP__?.reusesSettings === true;
  const compositorResizeReady = isLinux ? invoke("compositor_resize_supported")
    .then((supported) => {
      if (supported) {
        const apply = () => document.body.classList.add("linuxOverlay");
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
        else apply();
      }
      return supported;
    })
    .catch(() => false)
    : Promise.resolve(false);

  // Three windows share this bundle: the game overlay (label "main"), the
  // Details view ("details") which the user can park on a second monitor, and
  // Settings ("settings"). Which one we are is needed synchronously, before
  // anything else initialises.
  //
  // __A2_VIEW__ is injected by the window's initialization_script and runs
  // before any page script. getCurrentWindow().label agrees with it and is kept
  // as a fallback, but the injected value is preferred because it does not
  // depend on the Tauri JS API being present: a window missing from
  // capabilities/default.json gets no API injected at all, and the fallback
  // would then throw rather than answer.
  let viewMode = "main";
  try {
    const injected = window.__A2_VIEW__;
    const fromUrl = new URLSearchParams(window.location.search).get("view");
    // Per-fight windows are labelled details-<id>, so the label is only a
    // fallback for the singletons; the injected value is what identifies them.
    const label = window.__TAURI__?.window?.getCurrentWindow?.()?.label;
    const candidate = injected || fromUrl || label;
    if (candidate === "details" || candidate === "settings" || candidate === "history") {
      viewMode = candidate;
    }
  } catch {}
  window.A2_VIEW = viewMode;
  if (viewMode === "details") {
    document.documentElement.classList.add("detailsWindow");
  } else if (viewMode === "settings") {
    document.documentElement.classList.add("settingsWindow");
  } else if (viewMode === "history") {
    document.documentElement.classList.add("historyWindow");
  }

  // Tool-window bootstrap. This runs regardless of whether app startup
  // succeeds, so a failure in core.js can never leave a window the user can see
  // but not use.
  if (viewMode !== "main") {
    // Show this window's panel here rather than relying on core.js. Its start()
    // does a lot of work and is wrapped in a try/catch, so a single failure in
    // an unrelated part of it used to leave the tool window blank.
    const PANEL_FOR_VIEW = {
      settings: [".settingsPanel", "isOpen"],
      history: [".historyPanel", "open"],
      details: [".detailsPanel", "open"],
    };
    const showPanel = () => {
      const [sel, cls] = PANEL_FOR_VIEW[viewMode] || PANEL_FOR_VIEW.details;
      document.querySelector(sel)?.classList.add(cls);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", showPanel, { once: true });
    } else {
      showPanel();
    }

    // A blank tool window is impossible to diagnose from the outside, so make
    // startup failures visible in the window itself.
    window.addEventListener("error", (event) => {
      try {
        let bar = document.querySelector(".toolWindowError");
        if (!bar) {
          bar = document.createElement("div");
          bar.className = "toolWindowError";
          bar.style.cssText =
            "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:8px 12px;" +
            "background:#4a1220;color:#ffd9df;font:12px/1.4 ui-monospace,Consolas,monospace;" +
            "white-space:pre-wrap;max-height:40vh;overflow:auto;border-top:1px solid #ff5f7a";
          document.body.appendChild(bar);
        }
        bar.textContent += `${event.message}
    at ${event.filename}:${event.lineno}:${event.colno}
`;
      } catch {}
    });

    // WebView2 tool windows must load visible. Linux Settings instead reveals
    // directly from notifyUiReady, after preparing the form; a hidden webview
    // need not run animation frames, so its reveal must not wait for one.
    const reveal = () => {
      try {
        const w = window.__TAURI__.window.getCurrentWindow();
        w.show();
        w.setFocus();
      } catch (e) {
        console.error("[Daeva] reveal failed", e);
      }
    };
    const scheduleReveal = () => requestAnimationFrame(() => requestAnimationFrame(reveal));
    if (!(loadsHidden && viewMode === "settings")) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", scheduleReveal, { once: true });
      } else {
        scheduleReveal();
      }
      // Belt and braces if rAF never fires (window fully occluded at creation).
      setTimeout(reveal, 1200);
    }
  }

  // --- Cached state ---
  let settingsCache = {};
  let settingsLoaded = false;
  let cachedDpsJson = null;      // latest DPS snapshot as JSON string
  let cachedPing = null;
  let cachedCaptureStatus = null;
  let cachedDetailsContext = null;
  let cachedAppVersion = "";     // populated on startup from Tauri backend
  let lastSkillDetailsIssue = "";
  let captureSuspended = false;  // the suspend button's state; the backend's is the truth
  // null awaits the first show; false is an explicitly paused form.
  let settingsActive = viewMode === "settings" && loadsHidden ? null : true;
  let settingsLifecycleGeneration = 0;
  let settingsReadId = 0;
  let settingsReadPromise = null;
  let settingsRevision = 0;
  const settingsKeyRevisions = new Map();
  const cacheSetting = (key, value) => {
    settingsKeyRevisions.set(key, ++settingsRevision);
    settingsCache[key] = String(value);
    try { localStorage.setItem(key, String(value)); } catch {}
  };
  // Linux keeps Settings when it is closed. Shown again, it resumes; not every
  // change is broadcast as setting-changed, so the backend is read again.
  const resumeSettings = ({ resync = true } = {}) => {
    if (viewMode !== "settings" || settingsActive) return;
    settingsActive = true;
    startStatusPolling();
    if (resync && reusesSettings) loadSettings().then((applied) => {
      if (applied && settingsActive) window._dpsApp?.syncSettingsForm?.();
    });
  };
  let devicesLoading = null;
  let devicesLoadedAt = 0;
  const DEVICES_STALE_MS = 10000;
  const loadDevices = () => {
    if (!devicesLoading) {
      devicesLoading = invoke("get_available_devices")
        .then((devices) => {
          window._cachedDevices = devices;
          devicesLoadedAt = Date.now();
          return devices;
        })
        .finally(() => { devicesLoading = null; });
    }
    return devicesLoading;
  };

  // A reloaded window picks the suspend state back up from the backend.
  invoke("is_capture_suspended").then((v) => {
    captureSuspended = !!v;
  }).catch(() => {});

  // Fetch app version from backend (sourced from Cargo.toml via env!("CARGO_PKG_VERSION"))
  invoke("get_app_version").then((v) => {
    if (typeof v === "string") cachedAppVersion = v;
  }).catch(() => {});

  // Load settings from Rust backend and merge with localStorage.
  // localStorage acts as the synchronous fallback for first reads before invoke resolves.
  const loadSettings = () => {
    const readId = ++settingsReadId;
    const revision = settingsRevision;
    const pending = invoke("get_settings").then((s) => {
      if (readId !== settingsReadId) return false;
      settingsLoaded = true;
      if (!s || typeof s !== "object" || Array.isArray(s)) return false;
      const merged = { ...s };
      // An event or local edit after this read began is newer than its snapshot.
      for (const [key, changed] of settingsKeyRevisions) {
        if (changed > revision) merged[key] = settingsCache[key];
      }
      for (const key of Object.keys(settingsCache)) {
        if (!(key in merged)) {
          try { localStorage.removeItem(key); } catch {}
        }
      }
      settingsCache = merged;
      for (const [key, value] of Object.entries(merged)) {
        try { localStorage.setItem(key, value); } catch {}
      }
      return true;
    }).catch(() => {
      if (readId === settingsReadId) settingsLoaded = true;
      return false;
    });
    settingsReadPromise = pending;
    return pending;
  };
  loadSettings();
  window.a2SettingsReady = (async () => {
    // A reopen during startup can supersede the initial read.
    let pending;
    do { pending = settingsReadPromise; await pending; }
    while (pending !== settingsReadPromise);
  })();

  // --- DPS data polling via events ---
  // The Rust backend emits "dps-update" when it changes (checked every 100ms,
  // and sent again every 2 s while it doesn't).
  // We cache the latest snapshot so getDpsData() can return it synchronously,
  // and draw it now rather than at the meter's next 100 ms poll.
  if (viewMode !== "settings") listen("dps-update", (event) => {
    cachedDpsJson = JSON.stringify(event.payload);
    window._dpsApp?.fetchDps?.();
    // NOTE: do NOT pre-fetch get_details_context here. It clones the full combat
    // aggregate and runs O(targets×actors×skills) work; firing it every 500ms
    // (even with the details panel closed) was a major source of CPU lag that
    // grew with fight length. The details panel self-refreshes every 2s while
    // open (details.js), and getDetailsContext() below refreshes on demand.
  });

  // The backend sends an update when it changes (and every 2 s), so a window
  // opened while nothing changes asks for the current one.
  if (viewMode !== "settings") {
    invoke("get_dps_snapshot").then((dps) => {
      if (cachedDpsJson == null) cachedDpsJson = JSON.stringify(dps);
    }).catch(() => {});
  }

  if (viewMode !== "settings") listen("odyle-energy", (event) => {
    window._dpsApp?.updateOdyle?.(event.payload);
  });

  if (viewMode !== "settings") listen("ping-update", (event) => {
    cachedPing = event.payload;
    // Push directly to the app instance for immediate display update
    window._dpsApp?.updatePing?.(event.payload);
  });

  listen("capture-status-changed", (event) => {
    cachedCaptureStatus = event.payload;
    if (viewMode === "settings" && settingsActive) window._dpsApp?.refreshConnectionInfo?.();
  });

  // Settings live in their own window, so a change there has to reach the meter.
  // Refresh the local cache and hand the app the key so it can re-apply just
  // that option — see applyRemoteSettingChange() in core.js.
  listen("setting-changed", (event) => {
    const key = event?.payload?.key;
    const value = event?.payload?.value;
    if (typeof key !== "string") return;
    cacheSetting(key, value);
    window._dpsApp?.applyRemoteSettingChange?.(key, String(value));
  });

  // Settings was asked to open while already open: it resumes.
  const settingsShownSubscription = listen("settings-shown", () => {
    if (viewMode === "settings") ++settingsLifecycleGeneration;
    resumeSettings();
  });
  const settingsHiddenSubscription = viewMode === "settings" ? listen("settings-hidden", () => {
    window.dispatchEvent(new Event("settings-hidden"));
  }) : undefined;
  const settingsLifecycleReady = Promise.all([settingsShownSubscription, settingsHiddenSubscription]);

  listen("hotkey-status", (event) => {
    window._dpsApp?.applyHotkeyStatus?.(event?.payload || {});
  });

  // The meter's click-through turned on or off (its button, Settings, or
  // its keybind; plugins/overlay.rs): every window follows.
  listen("meter-click-through", (event) => {
    window._dpsApp?._onMeterClickThrough?.(!!event?.payload);
  });

  // Out of combat a while (Settings → Hide out of combat; app.rs): the meter
  // shrinks to its title bar's buttons until the next fight (styles.css).
  if (viewMode !== "settings") listen("meter-resting", (event) => {
    document.querySelector(".meter")?.classList.toggle("isResting", !!event?.payload);
  });

  listen("npcap-missing", () => {
    const msg = "Npcap is required for packet capture but is not installed.\n\nWould you like to download it now?";
    if (confirm(msg)) {
      shellOpen("https://npcap.com/#download");
    }
  });

  listen("combat-reset", () => {
    // Clear frontend state without re-invoking backend (already cleared by hotkey)
    cachedDpsJson = null;
    if (window._dpsApp) {
      window._dpsApp.refreshPending = false;
      window._dpsApp.lastJson = null;
      window._dpsApp.lastSnapshot = [];
      window._dpsApp._lastRenderedListSignature = "";
      window._dpsApp._lastRenderedRowsSummary = null;
      window._dpsApp._lastBattleTimeMs = null;
      window._dpsApp._battleTimeVisible = false;
      window._dpsApp.battleTime?.setVisible?.(false);
      window._dpsApp.meterUI?.onResetMeterUi?.();
    }
  });

  // ===== window.dpsData — polled by core.js every 100ms =====
  window.dpsData = {
    getDpsData() {
      return cachedDpsJson;
    },

    getDetailsContext() {
      // Return cached context synchronously; refresh in background
      invoke("get_details_context").then((ctx) => {
        cachedDetailsContext = ctx;
      }).catch(() => {});
      if (cachedDetailsContext) {
        return typeof cachedDetailsContext === "string"
          ? cachedDetailsContext
          : JSON.stringify(cachedDetailsContext);
      }
      return null;
    },

    async getTargetDetails(targetId, actorIdsJson) {
      try {
        const actorIds = actorIdsJson ? JSON.parse(actorIdsJson) : null;
        const result = await invoke("get_skill_details", {
          targetId: Number(targetId),
          actorIds: Array.isArray(actorIds) ? actorIds.map(Number) : null,
        });
        return JSON.stringify(result);
      } catch (e) {
        console.error("[Daeva] getTargetDetails error:", e);
        return null;
      }
    },

    // The live fight's buffs and debuffs on a target: { targetId, startTimeMs,
    // durationMs, buffs }, or null.
    async getFightBuffs(targetId) {
      try {
        return await invoke("get_fight_buffs", { targetId: Number(targetId) });
      } catch (e) {
        console.error("[Daeva] getFightBuffs error:", e);
        return null;
      }
    },

    async getBattleDetail(actorId, { summaryOnly = false } = {}) {
      const dps = cachedDpsJson ? JSON.parse(cachedDpsJson) : null;
      const targetIds = [...new Set((Array.isArray(dps?.detailTargetIds)
        ? dps.detailTargetIds : [dps?.targetId]).map(Number).filter((id) => id > 0))];
      if (!targetIds.length) {
        const issue = `no selected target (mode=${dps?.targetMode || "unknown"}, rows=${Object.keys(dps?.map || {}).length})`;
        if (issue !== lastSkillDetailsIssue) window.javaBridge?.logToDebug?.(`Skill details: ${issue}`);
        lastSkillDetailsIssue = issue;
        return null;
      }
      const aid = Number(actorId);
      // A long session may select dozens of targets. Bound IPC fan-out instead
      // of filling the native work queue with all of them at once.
      const results = new Array(targetIds.length);
      let nextTarget = 0;
      let failed = false;
      await Promise.all(Array.from({ length: Math.min(4, targetIds.length) }, async () => {
        while (!failed && nextTarget < targetIds.length) {
          const index = nextTarget++;
          try {
            results[index] = await invoke("get_skill_details", {
              targetId: targetIds[index],
              actorIds: Number.isFinite(aid) && aid > 0 ? [aid] : null,
              summaryOnly,
            });
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }));
      let result = results[0];
      if (results.length > 1) {
        const startTime = Math.min(...results.map((item) => Number(item.startTime) || 0));
        const mergeSkills = (field) => {
          const merged = new Map();
          const sumFields = ["time", "dmg", "multiHitCount", "multiHitDamage", "multiHitHits",
            "crit", "parry", "back", "frontal", "perfect", "double", "shieldBlock", "ironWall",
            "regeneration", "perfectBlock", "miss", "resist", "regen"];
          for (const item of results) {
            const offset = (Number(item.startTime) || 0) - startTime;
            for (const skill of item[field] || []) {
              const key = `${skill.actorId}:${skill.code}:${Boolean(skill.isDot)}`;
              const timestamps = (skill.hitTimestamps || []).map((ts) => Number(ts) + offset);
              const entry = merged.get(key);
              if (!entry) {
                merged.set(key, { ...skill, hitTimestamps: timestamps, specs: [...(skill.specs || [])] });
                continue;
              }
              for (const name of sumFields) entry[name] = (Number(entry[name]) || 0) + (Number(skill[name]) || 0);
              const minimums = [entry.minDmg, skill.minDmg].map(Number).filter((n) => n > 0);
              entry.minDmg = minimums.length ? Math.min(...minimums) : 0;
              entry.maxDmg = Math.max(Number(entry.maxDmg) || 0, Number(skill.maxDmg) || 0);
              entry.hitTimestamps.push(...timestamps);
              entry.specs.push(...(skill.specs || []));
            }
          }
          return [...merged.values()];
        };
        result = {
          targetId: 0, maxHp: 0, startTime,
          battleTime: Number(dps.battleTime) || 0,
          totalTargetDamage: results.reduce((sum, item) => sum + (Number(item.totalTargetDamage) || 0), 0),
          skills: mergeSkills("skills"), healSkills: mergeSkills("healSkills"), pingHistory: [],
          // Each target's deaths are timed from its own start: none for several.
          deaths: null,
        };
      }
      const issue = Array.isArray(result?.skills) && result.skills.length
        ? "" : `empty response for targets=${targetIds.join(",")}`;
      if (issue && issue !== lastSkillDetailsIssue) window.javaBridge?.logToDebug?.(`Skill details: ${issue}`);
      lastSkillDetailsIssue = issue;
      return summaryOnly ? result : JSON.stringify(result);
    },

    getVersion() {
      return cachedAppVersion;
    },
  };

  // ===== window.javaBridge — called by various JS modules =====
  window.javaBridge = {
    // --- Details window (second monitor) ---
    listMonitors() {
      return invoke("list_monitors").catch(() => []);
    },
    openDetailsWindow(monitorIndex) {
      return invoke("open_details_window", { monitorIndex: Number(monitorIndex) || 0 });
    },
    closeDetailsWindow() {
      return invoke("close_details_window").catch(() => {});
    },
    // Details is one surface. The overlay never opens the panel inside itself —
    // it describes what to show and the standalone window (created on demand)
    // renders it. Rejections are surfaced so core.js can fall back in-overlay.
    requestDetailsView(payload) {
      return invoke("request_details_view", { payload: payload || {} });
    },
    takePendingDetailsRequest() {
      // No label argument — the backend reads it from the calling window, so a
      // window can only ever claim the request that was parked for it.
      return invoke("take_pending_details_request").catch(() => null);
    },
    closeToolWindow() {
      return invoke("close_tool_window").catch(() => {});
    },
    detailsWindowReady() {
      try {
        const w = window.__TAURI__.window.getCurrentWindow();
        w.show();
        w.setFocus();
      } catch (e) {
        console.error("[Daeva] revealSelf failed", e);
      }
      return invoke("details_window_ready").catch(() => {});
    },
    openSettingsWindow() {
      return invoke("open_settings_window").catch((e) => console.error("[Daeva] openSettingsWindow", e));
    },
    closeSettingsWindow() {
      return invoke("close_settings_window").catch(() => {});
    },
    toolWindowReady(label) {
      // Linux Settings loads hidden; notifyUiReady reveals it once the form is ready.
      if (loadsHidden && label === "settings") return Promise.resolve();
      // Reveal from the window's own webview thread. Calling show() on the Rust
      // side from a spawned task did not take effect — the window stayed created
      // but unmapped — so the window shows itself and the backend call is only
      // a fallback for focus.
      try {
        const w = window.__TAURI__.window.getCurrentWindow();
        w.show();
        w.setFocus();
      } catch (e) {
        console.error("[Daeva] revealSelf failed", e);
      }
      return invoke("tool_window_ready", { label: String(label) }).catch(() => {});
    },
    async notifyUiReady() {
      if (!loadsHidden) return;
      if (viewMode === "settings") {
        await settingsLifecycleReady;
        const generation = settingsLifecycleGeneration;
        // Lay out the translated form before mapping the native window.
        document.querySelector(".settingsPanel")?.getBoundingClientRect();
        // The backend shows it only if it is still wanted: a Close may have
        // come first, and then paused the form.
        const shown = await invoke("tool_window_ready", { label: "settings" }).catch(() => false);
        if (generation !== settingsLifecycleGeneration) return;
        if (shown) resumeSettings({ resync: settingsActive === false });
        else window.dispatchEvent(new Event("settings-hidden"));
        return;
      }
      if (viewMode !== "main") return;
      // The overlay lays the meter out before its window is mapped.
      await updateWindowSize();
      await invoke("main_window_ready").catch(() => {});
    },

    // --- Settings ---
    getSetting(key) {
      return settingsCache[key] ?? localStorage.getItem(key);
    },
    setSetting(key, value) {
      // A full storage quota must not keep the setting from the backend.
      cacheSetting(key, value);
      invoke("update_settings", { key, value: String(value) }).catch(() => {});
      // Reload backend i18n data when language changes
      if (key === "dpsMeter.language") {
        invoke("set_language", { language: String(value) }).catch(() => {});
      }
    },
    clearAllSettings() {
      ++settingsReadId;
      ++settingsRevision;
      settingsKeyRevisions.clear();
      try { localStorage.clear(); } catch {}
      settingsCache = {};
      invoke("clear_settings").catch(() => {});
    },

    // --- DPS & Combat ---
    resetDps() {
      invoke("reset_combat").catch(() => {});
      cachedDpsJson = null;
      // Clear frontend state and skip the 1s grace period
      if (window._dpsApp) {
        window._dpsApp.refreshPending = false;
        window._dpsApp.lastJson = null;
        window._dpsApp.lastSnapshot = [];
        window._dpsApp._lastRenderedListSignature = "";
        window._dpsApp._lastRenderedRowsSummary = null;
        window._dpsApp._lastBattleTimeMs = null;
        window._dpsApp._battleTimeVisible = false;
        window._dpsApp.battleTime?.setVisible?.(false);
        window._dpsApp.meterUI?.onResetMeterUi?.();
      }
    },
    restartTargetSelection() {
      this.resetDps();
    },
    setTargetSelection(mode) {
      invoke("set_target_mode", { mode }).catch(() => {});
    },
    // `manual`: the player typed it, so the backend takes it even after the
    // game has named the character.
    setCharacterName(name, manual) {
      invoke("set_character_name", { name, manual: !!manual }).catch(() => {});
    },
    // `manual`: the player typed the id in Settings. Otherwise this is the
    // window echoing the id it last saw, which the backend ignores once the
    // game has named someone else.
    bindLocalActorId(actorId, manual) {
      const id = Number(actorId);
      if (!Number.isFinite(id) || id <= 0) return;
      // Always invoke — the backend is idempotent and needs to reapply the
      // permanent nickname if the character name was set after the initial bind.
      window._boundLocalActorId = id;
      invoke("bind_local_actor_id", { actorId: id, manual: !!manual }).catch(() => {});
      // Also bind nickname if we can find it from any source
      const name =
        window._dpsApp?.USER_NAME ||
        document.querySelector(".characterNameInput")?.value?.trim() ||
        "";
      if (name) {
        this.bindLocalNickname(actorId, name);
      }
      // Force immediate meter refresh so the name shows right away
      invoke("get_dps_snapshot").then((dps) => {
        cachedDpsJson = JSON.stringify(dps);
      }).catch(() => {});
    },
    setLocalPlayerId(actorId) {
      this.bindLocalActorId(actorId);
    },
    bindLocalNickname(actorId, nickname) {
      const id = Number(actorId);
      if (!Number.isFinite(id) || id <= 0 || !nickname) return;
      // Always invoke — backend handles idempotency and will refresh the
      // nickname even if the (id:nickname) pair was previously sent.
      window._boundLocalNickname = `${id}:${nickname}`;
      invoke("bind_local_nickname", { actorId: id, nickname }).catch(() => {});
    },
    setAllTargetsWindowMs() {},
    setTrainSelectionMode() {},

    // --- Window ---
    moveWindow() {
      // No-op: the overlay moves the meter (overlay.js, "Moving the meter"
      // below). core.js's own drag never starts, as that press is taken here
      // first.
    },
    exitApp() {
      invoke("quit_app").catch(() => {});
    },

    // --- Browser ---
    openBrowser(url) {
      invoke("open_url", { url }).catch(() => {});
    },

    // --- Ping ---
    getPingMs() {
      return cachedPing;
    },

    // --- Connection Info ---
    getConnectionInfo() {
      return cachedCaptureStatus ? JSON.stringify(cachedCaptureStatus) : null;
    },
    getLastParsedAtMs() {
      return 0;
    },
    getAvailableDevices() {
      // Stale-while-revalidate: answer now, refresh an old list in the background.
      if (!window._cachedDevices || Date.now() - devicesLoadedAt > DEVICES_STALE_MS) {
        loadDevices().catch(() => {});
      }
      return JSON.stringify(window._cachedDevices || []);
    },
    // The same list, for a caller that can wait for it.
    loadAvailableDevices() {
      return loadDevices();
    },
    setManualDevice(device) {
      invoke("set_manual_device", { device: device || "" }).catch(() => {});
    },
    resetAutoDetection() {
      invoke("reset_auto_detection").catch(() => {});
    },

    // --- Screenshots ---
    // Screenshots. The backend measures against whichever window calls, so the
    // Details window captures (and saves) itself. Coordinates are the page's
    // CSS pixels; `scale` is devicePixelRatio, which the backend needs to map
    // them onto the screen at 125%/150% display scaling.
    // Resolves to { clipboard: bool, file: path | null }.
    captureScreenshot({ x, y, width, height, scale, includeMeter, saveFile, folder, filename }) {
      return invoke("capture_screenshot", {
        x, y, width, height,
        scale: scale || window.devicePixelRatio || 1,
        includeMeter: !!includeMeter,
        saveFile: !!saveFile,
        folder: folder || null,
        filename: filename || null,
      }).catch(() => ({ clipboard: false, file: null }));
    },
    captureScreenshotToClipboard(x, y, w, h, scale) {
      this.captureScreenshot({ x, y, width: w, height: h, scale });
      return true;
    },
    // Resolves to the chosen folder, or null if the player cancels.
    chooseScreenshotFolder(current) {
      return invoke("choose_screenshot_folder", { current: current || null }).catch(() => null);
    },
    getDefaultScreenshotFolder() {
      return window._defaultScreenshotFolder || "";
    },

    // --- Hotkeys ---
    getCurrentHotKey() {
      // The backend's default (app.rs, start_hotkeys). "Ctrl+Alt+Shift+R"
      // here since 2.0.6 showed a key that was never registered.
      return this.getSetting("dpsMeter.hotkey") || "Ctrl+Alt+R";
    },
    getCurrentToggleWindowHotKey() {
      return this.getSetting("dpsMeter.toggleWindowHotkey") || "Ctrl+Alt+Up";
    },
    getCurrentLockHotKey() {
      return this.getSetting("dpsMeter.lockHotkey") || "Ctrl+Alt+L";
    },
    // The meter's click-through (app.rs, HOTKEY_DEFAULTS).
    getCurrentClickThroughHotKey() {
      return this.getSetting("dpsMeter.clickThroughHotkey") || "Ctrl+Alt+K";
    },
    setClickThroughHotkey(mods, vk) {
      this.setSetting("dpsMeter.clickThroughHotkey", this._buildHotkeyLabel(mods, vk));
    },
    // No default: "" until one is set.
    getCurrentPluginWindowsHotKey() {
      return this.getSetting("dpsMeter.pluginWindowsHotkey") || "";
    },
    setPluginWindowsHotkey(mods, vk) {
      this.setSetting("dpsMeter.pluginWindowsHotkey", this._buildHotkeyLabel(mods, vk));
    },
    // The packet-capture marks (app.rs, mark_capture): no default either.
    getCurrentMarkVisibleHotKey() {
      return this.getSetting("dpsMeter.markVisibleHotkey") || "";
    },
    setMarkVisibleHotkey(mods, vk) {
      this.setSetting("dpsMeter.markVisibleHotkey", this._buildHotkeyLabel(mods, vk));
    },
    getCurrentMarkPickupHotKey() {
      return this.getSetting("dpsMeter.markPickupHotkey") || "";
    },
    setMarkPickupHotkey(mods, vk) {
      this.setSetting("dpsMeter.markPickupHotkey", this._buildHotkeyLabel(mods, vk));
    },
    // Every keybind back to its default (app.rs, HOTKEY_DEFAULTS).
    // Linux: the desktop's own shortcut settings (KDE, GNOME, or the portal's).
    openDesktopShortcuts() {
      return invoke("open_desktop_shortcuts");
    },
    restoreDefaultHotkeys() {
      this.setSetting("dpsMeter.hotkey", "Ctrl+Alt+R");
      this.setSetting("dpsMeter.toggleWindowHotkey", "Ctrl+Alt+Up");
      this.setSetting("dpsMeter.lockHotkey", "Ctrl+Alt+L");
      this.setSetting("dpsMeter.clickThroughHotkey", "Ctrl+Alt+K");
      this.setSetting("dpsMeter.pluginWindowsHotkey", "");
      this.setSetting("dpsMeter.markVisibleHotkey", "");
      this.setSetting("dpsMeter.markPickupHotkey", "");
    },
    // Each key's registration: { <key>: "ok" | "taken" | "unset", and on
    // Linux "<key>.assigned": the key the desktop gave it }.
    getHotkeyStatus() {
      return invoke("get_hotkey_status").catch(() => ({}));
    },
    setLockHotkey(mods, vk) {
      this.setSetting("dpsMeter.lockHotkey", this._buildHotkeyLabel(mods, vk));
    },
    // The meter's click-through (plugins/overlay.rs): on, only its title
    // bar's buttons take clicks. Every window hears "meter-click-through".
    setMeterClickThrough(on) {
      return invoke("meter_set_click_through", { on: !!on }).catch(() => {});
    },
    getMeterClickThrough() {
      return invoke("meter_click_through_on").catch(() => false);
    },
    setHotkey(mods, vk) {
      const label = this._buildHotkeyLabel(mods, vk);
      this.setSetting("dpsMeter.hotkey", label);
    },
    setToggleWindowHotkey(mods, vk) {
      const label = this._buildHotkeyLabel(mods, vk);
      this.setSetting("dpsMeter.toggleWindowHotkey", label);
    },
    _buildHotkeyLabel(mods, vk) {
      const parts = [];
      if (mods & 0x02) parts.push("Ctrl");
      if (mods & 0x01) parts.push("Alt");
      if (mods & 0x04) parts.push("Shift");
      if (mods & 0x08) parts.push("Win");
      // Map common VK codes to names
      const vkNames = {
        0x08: "Backspace", 0x09: "Tab", 0x0D: "Enter", 0x1B: "Esc",
        0x20: "Space", 0x21: "PageUp", 0x22: "PageDown", 0x23: "End",
        0x24: "Home", 0x25: "Left", 0x26: "Up", 0x27: "Right", 0x28: "Down",
        0x2D: "Insert", 0x2E: "Delete",
        0x70: "F1", 0x71: "F2", 0x72: "F3", 0x73: "F4", 0x74: "F5",
        0x75: "F6", 0x76: "F7", 0x77: "F8", 0x78: "F9", 0x79: "F10",
        0x7A: "F11", 0x7B: "F12",
      };
      const keyName = vkNames[vk] || String.fromCharCode(vk);
      parts.push(keyName);
      return parts.join("+");
    },

    // --- Feature flags ---
    isRunningFromIde() { return false; },
    getParsingBacklog() { return 0; },
    // The header's suspend button. The backend owns the switch; this keeps a
    // copy so the UI can read it synchronously, as it does at load.
    isCaptureSuspended() { return captureSuspended; },
    suspendCapture(suspended) {
      captureSuspended = !!suspended;
      invoke("suspend_capture", { suspended: captureSuspended }).catch(() => {});
    },
    setBossLogsEnabled() {},
    setAutoHideMeter(enabled) {
      invoke("update_settings", { key: "dpsMeter.autoHideMeter", value: String(enabled) }).catch(() => {});
    },
    setSaveRawPackets(enabled) {
      invoke("set_packet_logging", { enabled: !!enabled }).catch(() => {});
    },
    setDebugLoggingEnabled(enabled) {
      invoke("set_debug_logging", { enabled: !!enabled }).catch(() => {});
    },
    getAion2WindowTitle() { return window._cachedAion2Title ?? null; },
    logDebug() {},

    getFightHistory() {
      // Trigger async refresh for next call
      invoke("get_fight_history").then((h) => { window._cachedFightHistory = h; }).catch(() => {});
      if (window._cachedFightHistory) {
        return JSON.stringify(window._cachedFightHistory);
      }
      // First call: block briefly with synchronous fallback
      return "[]";
    },

    // Await the cache actually being filled. getFightHistory() is synchronous
    // and answers from window._cachedFightHistory, which a prefetch populates
    // asynchronously — so a window created in order to show History renders
    // before its own prefetch lands and gets an empty list.
    refreshFightHistory() {
      return invoke("get_fight_history")
        .then((h) => { window._cachedFightHistory = h; return true; })
        .catch(() => false);
    },

    getFightDetails(id) {
      // Async — returns a promise
      return invoke("load_fight", { id }).then((r) => JSON.stringify(r)).catch(() => null);
    },

    // The stream overlay for OBS on another PC, as
    // { enabled, running, port, urls, error }. Configure and New key resolve
    // with the status after the change; configure rejects a bad port.
    streamOverlayStatus() {
      return invoke("stream_overlay_status");
    },
    streamOverlayConfigure(enabled, port) {
      return invoke("stream_overlay_configure", { enabled: !!enabled, port: Number(port) });
    },
    streamOverlayNewKey() {
      return invoke("stream_overlay_new_key");
    },

    deleteFight(id) {
      invoke("delete_fight", { id }).catch(() => {});
      return true;
    },

    // --- Resources ---
    readResource(path) {
      // Load resource files synchronously via XMLHttpRequest.
      // Try multiple path prefixes since files may be at root or under /src/data/.
      const candidates = [path, "/src/data" + path, "/src" + path];
      for (const url of candidates) {
        try {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url, false); // synchronous
          xhr.send();
          if (xhr.status === 200 && xhr.responseText) {
            return xhr.responseText;
          }
        } catch {
          // try next
        }
      }
      return null;
    },
    // The cached icon, once read from disk (null when there is none).
    readCachedIconAsync(key) {
      if (!key) return Promise.resolve(null);
      if (window._iconCache?.[key] !== undefined) return Promise.resolve(window._iconCache[key]);
      return invoke("read_cached_icon", { key }).then((data) => {
        if (!window._iconCache) window._iconCache = {};
        window._iconCache[key] = data ?? null;
        return data ?? null;
      }).catch(() => null);
    },
    readCachedIcon(key) {
      // Synchronous read from Rust via cached map
      if (!key) return null;
      if (window._iconCache?.[key] !== undefined) return window._iconCache[key];
      // Trigger async load for next call
      invoke("read_cached_icon", { key }).then((data) => {
        if (!window._iconCache) window._iconCache = {};
        window._iconCache[key] = data ?? null;
      }).catch(() => {});
      return null;
    },
    // A line in debug.log, for problems only the UI sees.
    logToDebug(message) {
      invoke("log_from_ui", { message: String(message) }).catch(() => {});
    },
    writeCachedIcon(key, data) {
      if (!key || !data) return;
      if (!window._iconCache) window._iconCache = {};
      window._iconCache[key] = data;
      invoke("write_cached_icon", { key, data }).catch(() => {});
    },

    // --- Fetch ---
    fetchUrlAsync(url, callbackId) {
      // checkRelease.js registers a callback via window._fetchUrlCallback(id, raw)
      if (window.a2Build?.online === false) {
        if (callbackId && typeof window._fetchUrlCallback === "function") {
          window._fetchUrlCallback(callbackId, JSON.stringify({ error: "not in this build" }));
        }
        return;
      }
      // Add cache-buster and no-cache headers to avoid stale CDN responses
      const bustUrl = url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
      fetch(bustUrl, { cache: "no-store" })
        .then((r) => r.text())
        .then((text) => {
          if (callbackId && typeof window._fetchUrlCallback === "function") {
            window._fetchUrlCallback(callbackId, text);
          }
        })
        .catch(() => {
          if (callbackId && typeof window._fetchUrlCallback === "function") {
            window._fetchUrlCallback(callbackId, JSON.stringify({ error: "fetch failed" }));
          }
        });
    },

    // --- Admin ---
    isAdmin() {
      return invoke("is_admin");
    },
  };


  // Poll AION2 window title and capture status from Rust backend
  const pollStatus = () => {
    const title = invoke("get_aion2_window_title")
      .then((title) => { window._cachedAion2Title = title ?? null; })
      .catch(() => { window._cachedAion2Title = null; });

    const status = invoke("get_capture_status")
      .then((status) => { cachedCaptureStatus = status; })
      .catch(() => {});
    // Settings has no title poll of its own; this one runs only while it is shown.
    if (viewMode === "settings") Promise.all([title, status]).then(() => {
      if (settingsActive) window._dpsApp?.refreshSettingsStatus?.();
    });
  };
  let statusTimer = null;
  const startStatusPolling = () => {
    if (statusTimer !== null) return;
    pollStatus();
    statusTimer = setInterval(pollStatus, 3000);
  };
  // A repeat without a show in between is ignored.
  if (viewMode === "settings") window.addEventListener("settings-hidden", () => {
    ++settingsLifecycleGeneration;
    window._dpsApp?.invalidateStreamOverlaySettings?.();
    if (settingsActive === false) return;
    settingsActive = false;
    clearInterval(statusTimer);
    statusTimer = null;
    document.activeElement?.blur?.();
    document.querySelectorAll(".settingsDropdownMenu.isOpen").forEach(menu => menu.classList.remove("isOpen"));
  });
  if (viewMode !== "settings" || settingsActive) startStatusPolling();

  // ===== Resizing =====
  // The meter is part of the overlay (overlay.js, plugins/overlay.rs): its
  // window covers the game's screen and never changes size for it. The corner
  // handle resizes the meter in the page (core.js bindResizeHandle). The tool
  // windows (Settings, History, Details) are resized from their edges on
  // Linux, through the compositor where it can (startNativeResize).
  let nativeResize = null;
  let primaryHeld = false;

  const finishNativeResize = (cancel = false) => {
    const operation = nativeResize;
    if (!operation) return Promise.resolve(true);
    operation.cancel = operation.cancel || cancel;
    if (operation.finished) return operation.finished;
    operation.finished = (async () => {
      // A release may arrive before the start IPC settles.
      await operation.started;
      // Consume the compositor's final configure before pinning the size again.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      let finished = false;
      try {
        const cancelRequested = operation.cancel;
        finished = await invoke("finish_window_resize", { cancel: cancelRequested });
        // Preserve cancellation requested during the pointer-return check.
        if (!finished && operation.cancel && !cancelRequested) {
          finished = await invoke("finish_window_resize", { cancel: true });
        }
      } catch (error) {
        console.error("[Daeva] finishing native resize failed", error);
      }
      if (!finished) {
        // WebKit can emit hover events during a grab; GTK must confirm release.
        operation.finished = null;
        return false;
      }
      nativeResize = null;
      return true;
    })();
    return operation.finished;
  };

  const startNativeResize = async (direction, minWidth, minHeight) => {
    if (nativeResize && !await finishNativeResize(true)) return;
    if (!primaryHeld) return;
    const operation = { finished: null, started: null, cancel: false };
    nativeResize = operation;
    operation.started = invoke("begin_window_resize", {
      minWidth, minHeight, scale: window.devicePixelRatio || 1,
    }).then((held) => {
      if (held) return window.__TAURI__.window.getCurrentWindow().startResizeDragging(direction);
      queueMicrotask(() => finishNativeResize(true));
    }).catch((error) => {
      console.error("[Daeva] native window resize failed", error);
      // Run after this promise settles, so finishing cannot await itself.
      queueMicrotask(() => finishNativeResize(true));
    });
  };

  // GTK3 hides the compositor resize state. End on returned pointer input,
  // not a pause in motion; GTK rejects synthetic WebKit hover events.
  const finishOnPointerReturn = (event) => {
    const inside = event.clientX >= 0 && event.clientY >= 0
      && event.clientX < window.innerWidth && event.clientY < window.innerHeight;
    if ((event.buttons & 1) === 0 && inside) {
      if (!nativeResize) primaryHeld = false;
      finishNativeResize();
    }
  };
  if (viewMode !== "main") {
    document.addEventListener("pointermove", finishOnPointerReturn, { capture: true });
    document.addEventListener("pointerover", finishOnPointerReturn, { capture: true });
    document.addEventListener("mouseup", (event) => {
      if (event.button !== 0) return;
      primaryHeld = false;
      finishNativeResize();
    }, { capture: true });
    document.addEventListener("mousedown", (event) => {
      primaryHeld = event.button === 0;
      finishNativeResize(true);
    }, { capture: true });
  }

  // The meter changed (rows, a panel, a card, its size): the overlay lays it
  // out again and says where it takes the mouse. Tool windows own their own
  // geometry.
  const updateWindowSize = () => {
    if (viewMode === "main") window.a2Overlay?.meterChanged?.();
    return Promise.resolve(true);
  };

  window.javaBridge.updateOverlaySize = updateWindowSize;

  // Watch all class changes on the container to catch panel open/close instantly
  const containerObserver = new MutationObserver(() => updateWindowSize());
  const startObserving = () => {
    const container = document.querySelector(".container");
    if (container) {
      containerObserver.observe(container, {
        attributes: true,
        attributeFilter: ["class"],
        subtree: true,
      });
    }
  };
  if (viewMode === "main" && document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserving);
  } else if (viewMode === "main") {
    startObserving();
  }
  // Fallback poll (cheap: the overlay says nothing when nothing moved).
  if (viewMode === "main") setInterval(updateWindowSize, 500);

  // The meter shown again: its rows may have changed meanwhile.
  listen("force-resize", () => {
    staleHover();
    updateWindowSize();
  });

  // The meter has no drag and drop. A press that lands on row text or an icon
  // would otherwise start a native drag of it, and under XWayland a drag the
  // meter never finishes holds the pointer (a no-drop cursor with the text
  // stuck to it) until it times out, about a minute, even after the meter quits.
  document.addEventListener("dragstart", (e) => e.preventDefault(), { capture: true });

  // ===== Moving the meter =====
  // The overlay moves it (overlay.js pressMeter): a press on its title bar,
  // footer or any empty part of it drags it, unless everything is locked.
  // Taken here in the capture phase, before core.js sees it (its own drag
  // moved a window, which the meter no longer has). Clicks on buttons, rows
  // and panels go through as usual.
  if (viewMode === "main") document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const target = e.target?.nodeType === Node.TEXT_NODE ? e.target.parentElement : e.target;
    // Let interactive elements handle their own clicks normally
    if (target?.closest?.("button, input, select, textarea, a, [data-no-drag]")) return;
    if (target?.closest?.(".headerBtn, .footerBtn, .bossIcon, .resizeHandle")) return;
    // Let panel internals work (close buttons, dropdowns, etc.)
    if (target?.closest?.(".settingsPanel, .historyPanel, .detailsBody, .detailsHeader, .detailsSettingsMenu")) return;
    // Let meter bar item clicks pass through for details/hover
    if (target?.closest?.(".item")) return;
    if (target?.closest?.(".meter")) {
      e.stopImmediatePropagation();
      window.a2Overlay?.pressMeter?.(e);
    }
  }, { capture: true });

  // ===== Tool windows: drag by the header; on Linux, resize from the edges =====
  // The tool windows are frameless, so the page starts the drag itself, through
  // start_tool_drag. Not -webkit-app-region: WebView2 moves a helper window
  // with SetWindowPos whenever the draggable area changes, and that call waits
  // on other windows (the game's among them), so Settings froze the whole app
  // for seconds at a time (2026-10-08). WebKitGTK ignores app-region anyway.
  // On Windows the window manager resizes them by their border; on Linux a
  // frameless window has no border to grab, so the page also starts the resize
  // through begin_tool_resize, which lifts the pinned size hints
  // (platform::window::set_size) for the length of the resize.
  const DRAG_HEADERS = ".historyHeader, .detailsHeader, .settingsHeader";
  const NO_DRAG = "button, a, input, select, textarea, [data-no-drag], "
    + ".historyViewToggle, .historyFilters, .historyClose, .detailsModeToggle, "
    + ".detailsSettingsMenuWrapper, .detailsScreenshotWrapper, .detailsWindowClose, .closeX";
  const dragFromHeader = (e) => {
    const target = e.target?.nodeType === Node.TEXT_NODE ? e.target.parentElement : e.target;
    if (!target?.closest?.(DRAG_HEADERS) || target.closest(NO_DRAG)) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    invoke("start_tool_drag").catch(() => {});
    return true;
  };
  if (window.A2_VIEW !== "main" && !isLinux) {
    document.addEventListener("mousedown", (e) => {
      if (e.button === 0) dragFromHeader(e);
    }, { capture: true });
  }
  if (window.A2_VIEW !== "main" && isLinux) {
    const MIN_SIZE = { settings: [520, 420], history: [480, 360], details: [520, 360] };
    const [minW, minH] = MIN_SIZE[window.A2_VIEW] || [480, 360];
    const EDGE = 6;

    const style = document.createElement("style");
    style.textContent = [
      ["n", "ns"], ["s", "ns"], ["e", "ew"], ["w", "ew"],
      ["ne", "nesw"], ["sw", "nesw"], ["nw", "nwse"], ["se", "nwse"],
    ].map(([edge, cur]) => `html.toolEdge-${edge}, html.toolEdge-${edge} * { cursor: ${cur}-resize !important; }`).join("\n");
    document.head.appendChild(style);

    const edgeAt = (e) => {
      let edge = "";
      if (e.clientY < EDGE) edge += "n";
      else if (e.clientY >= window.innerHeight - EDGE) edge += "s";
      if (e.clientX < EDGE) edge += "w";
      else if (e.clientX >= window.innerWidth - EDGE) edge += "e";
      return edge;
    };
    let shownEdge = "";
    const showEdge = (edge) => {
      if (edge === shownEdge) return;
      if (shownEdge) document.documentElement.classList.remove(`toolEdge-${shownEdge}`);
      if (edge) document.documentElement.classList.add(`toolEdge-${edge}`);
      shownEdge = edge;
    };

    const DIRECTION = {
      n: "North", s: "South", e: "East", w: "West",
      ne: "NorthEast", nw: "NorthWest", se: "SouthEast", sw: "SouthWest",
    };

    document.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const edge = edgeAt(e);
      if (edge) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // The backend unpins the size first, then the window manager resizes.
        compositorResizeReady.then((supported) => {
          if (supported) {
            startNativeResize(DIRECTION[edge], minW, minH);
          } else {
            return invoke("begin_tool_resize", { minWidth: minW, minHeight: minH })
              .then(() => window.__TAURI__.window.getCurrentWindow().startResizeDragging(DIRECTION[edge]));
          }
        })
          .catch((err) => console.error("[Daeva] tool window resize failed", err));
        return;
      }
      dragFromHeader(e);
    }, { capture: true });

    document.addEventListener("mousemove", (e) => showEdge(e.buttons ? "" : edgeAt(e)), { capture: true });
  }

  // Pre-fetch device list and fight history so they're ready when panels open
  if (viewMode !== "settings") {
    loadDevices().catch(() => {});
    invoke("get_fight_history").then((h) => { window._cachedFightHistory = h; }).catch(() => {});
  }
  if (viewMode !== "settings") invoke("default_screenshot_folder")
    .then((f) => {
      window._defaultScreenshotFolder = f || "";
      window._dpsApp?.updateScreenshotFolderDisplay?.();
    })
    .catch(() => {});
  // Refresh fight history periodically (picks up auto-saved fights)
  if (viewMode !== "settings") setInterval(() => {
    invoke("get_fight_history").then((h) => { window._cachedFightHistory = h; }).catch(() => {});
  }, 10000);

  // Startup diagnostics
  invoke("debug_status").then((s) => {
    console.log("[Daeva] Debug status:", JSON.stringify(s));
    if (!s.isAdmin) {
      console.warn("[Daeva] NOT RUNNING AS ADMIN — packet capture will not work!");
    }
  }).catch((e) => console.error("[Daeva] debug_status failed:", e));

  console.log("[Daeva] Tauri bridge adapter loaded (javaBridge + dpsData)");
})();
