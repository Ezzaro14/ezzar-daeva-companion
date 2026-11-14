// Settings → Plugins: the modules that come with the app (on or off, Open),
// and developer mode with its local folders (Reload, Remove;
// src-tauri/src/plugins).
(() => {
  if (window.__A2_VIEW__ !== "settings") return;
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  const t = (key, fallback, vars = {}) => {
    let text = window.i18n?.t?.(key, fallback) ?? fallback;
    for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, value);
    return text;
  };

  const start = () => {
    const toggle = document.querySelector(".pluginDevModeCheckbox");
    const devRow = document.querySelector(".pluginDevRow");
    const list = document.querySelector(".pluginList");
    const empty = document.querySelector(".pluginListEmpty");
    const add = document.querySelector(".pluginAddBtn");
    const update = document.querySelector(".pluginUpdateBtn");
    const status = document.querySelector(".pluginStatus");
    if (!toggle || !devRow || !list || !empty || !add || !update || !status) return;

    // The status line shows errors in red and other news in the hint colour.
    const say = (text, isError = true) => {
      status.textContent = text;
      status.classList.toggle("pluginError", isError && !!text);
    };

    let view = { devMode: false, plugins: [], disabled: [] };
    // Plugins the last reload changed, by id → the version before; marked
    // green until Settings closes.
    const updatedFrom = new Map();

    const button = (label, onClick, extra = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `settingsAction ${extra}`.trim();
      b.textContent = label;
      b.addEventListener("click", onClick);
      return b;
    };

    // A list row: a title (text and elements), a line under it, and buttons.
    const pluginRow = (title, subtitle, isError, buttons) => {
      const item = document.createElement("div");
      item.className = "settingsRow pluginItem";
      const info = document.createElement("div");
      info.className = "settingsInfo";
      const name = document.createElement("div");
      name.className = "settingsLabel";
      name.append(...title);
      const sub = document.createElement("div");
      sub.className = isError ? "settingsHint pluginError" : "settingsHint";
      sub.textContent = subtitle;
      info.append(name, sub);
      const end = document.createElement("div");
      end.className = "settingsRowEnd";
      end.append(...buttons);
      item.append(info, end);
      return item;
    };

    // On: the plugin starts with the meter. Off: installed, but not running.
    const enabledSwitch = (p, on) => {
      const control = document.createElement("label");
      control.className = "settingsToggleControl pluginEnabledToggle";
      const tip = t("settings.plugins.enabledTip", "On: starts with the meter. Off: stays installed but doesn't run.");
      control.title = tip;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = on;
      input.setAttribute("aria-label", `${t("settings.plugins.enabled", "Enabled")}: ${p.name}`);
      input.addEventListener("change", () => {
        say("");
        run(invoke("plugin_set_enabled", { id: p.id, enabled: input.checked }));
      });
      const track = document.createElement("span");
      track.className = "settingsToggleTrack";
      track.setAttribute("aria-hidden", "true");
      control.append(input, track);
      return control;
    };

    const run = (promise) => promise.then(render).catch((e) => say(String(e)));

    const render = (next) => {
      if (next) view = next;
      toggle.checked = !!view.devMode;
      devRow.hidden = !view.devMode;
      list.replaceChildren();
      for (const p of view.plugins || []) {
        const title = [p.error ? p.name : `${p.name} ${p.version}`];
        const wasUpdated = !p.error && updatedFrom.has(p.id);
        if (wasUpdated) {
          const from = updatedFrom.get(p.id);
          const badge = document.createElement("i");
          badge.className = "pluginUpdatedIcon";
          badge.setAttribute("data-lucide", "circle-arrow-up");
          badge.setAttribute("role", "img");
          const label = from
            ? t("settings.plugins.updatedFrom", "Updated from {version}", { version: from })
            : t("settings.plugins.added", "Newly loaded");
          badge.setAttribute("aria-label", label);
          badge.title = label;
          title.push(" ", badge);
        }
        if (!p.reviewed) {
          const tag = document.createElement("span");
          tag.className = "pluginUnreviewedTag";
          tag.textContent = t("settings.plugins.unreviewed", "Dev");
          tag.title = t("settings.plugins.hint", "Plugins loaded here are not reviewed. Only load plugins you trust.");
          title.push(" ", tag);
        }
        const buttons = [];
        const on = !(view.disabled || []).includes(p.id);
        if (!p.error) buttons.push(enabledSwitch(p, on));
        if (!p.error && on) {
          buttons.push(button(t("settings.plugins.open", "Open"), () => invoke("plugin_open", { id: p.id }).catch((e) => say(String(e)))));
        }
        // A developer folder can be let go of; a module is turned off instead.
        if (!p.bundled) buttons.push(button(t("settings.plugins.remove", "Remove"), () => {
          say("");
          run(invoke("plugin_remove_folder", { path: p.path }));
        }));
        const item = pluginRow(title, p.error || p.description || p.path, !!p.error, buttons);
        // Its windows and widgets hidden while AION2 is closed, or with the
        // meter while AION2 isn't in front (off: an alert's icon stays up).
        if (!p.error && on) {
          const options = document.createElement("div");
          options.className = "pluginHideOptions";
          for (const [when, list, key, text] of [
            ["closed", view.hideClosed, "settings.plugins.hideClosed", "Hide while AION2 is closed"],
            ["unfocused", view.hideUnfocused, "settings.plugins.hideUnfocused", "Hide when AION2 isn't focused"],
          ]) {
            const hide = document.createElement("label");
            hide.className = "pluginHideClosed";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = (list || []).includes(p.id);
            box.addEventListener("change", () => run(invoke("plugin_set_hide", { id: p.id, when, hide: box.checked })));
            hide.append(box, " ", t(key, text));
            options.append(hide);
          }
          item.querySelector(".settingsInfo")?.append(options);
        }
        if (wasUpdated) item.classList.add("pluginUpdated");
        if (!p.error && !on) item.classList.add("pluginOff");
        list.append(item);
      }
      empty.hidden = list.childElementCount > 0;
      window.lucide?.createIcons?.({ root: list });
    };

    // The list comes with whether developer mode is on.
    invoke("plugin_list").then(render).catch(() => {});

    toggle.addEventListener("change", () => {
      say("");
      run(invoke("plugin_set_dev_mode", { enabled: toggle.checked }));
    });
    update.addEventListener("click", () => {
      update.disabled = true;
      say(t("settings.plugins.checking", "Checking…"), false);
      invoke("plugin_check_updates")
        .then(({ view: next, updated }) => {
          for (const u of updated) updatedFrom.set(u.id, u.from || "");
          render(next);
          const changes = updated.map((u) => (u.from ? `${u.name} ${u.from} → ${u.to}` : `${u.name} ${u.to}`)).join(", ");
          say(updated.length
            ? t("settings.plugins.updated", "Updated: {list}", { list: changes })
            : t("settings.plugins.upToDate", "Every plugin is up to date."), false);
        })
        .catch((e) => say(String(e)))
        .finally(() => { update.disabled = false; });
    });
    add.addEventListener("click", () => {
      say("");
      run(invoke("plugin_add_folder"));
    });
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
