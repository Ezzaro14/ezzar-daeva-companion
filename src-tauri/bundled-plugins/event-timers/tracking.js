// What the player tracks (fork): the world bosses, Abyss bosses and events
// they chose, by hand, the first time (the dashboard's setup sends "setup")
// or on the Track tab. Only those show in the Timers list over the game
// (bosslist.js); a tracked one's bell gives a popup before it starts (its
// alert, as plugin.js keeps them). Nothing shows as icons any more.
// Uses plugin.js's helpers (EVENTS, FIELD_BOSSES, text, bossAlert, …).

// Everything that can be tracked, in groups: your side's world bosses
// first, then the other side's, the Abyss, and the events.
function trackGroups() {
  const side = character?.raceName ? (/asmo/i.test(character.raceName) ? "asmodian" : "elyos") : prefs.trackSide || null;
  const world = (s) =>
    Object.entries(FIELD_BOSSES)
      .filter(([, b]) => b.side === s)
      .map(([id, b]) => ({ id: `field:${id}`, name: text(b.name), sub: b.level ? `Lv ${b.level}` : "", level: b.level || 0 }))
      // The bigger bosses (Eternal Gartua, Lv 51) first.
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name));
  const abyss = [
    ...EVENTS.filter((e) => e.kind === "boss").map((e) => ({ id: e.id, name: text(e.name), sub: "Scheduled" })),
    ...Object.entries(FIELD_BOSSES)
      .filter(([, b]) => !b.side)
      .map(([id, b]) => ({ id: `field:${id}`, name: text(b.name), sub: b.level ? `Lv ${b.level} · respawns` : "respawns" })),
  ];
  const events = EVENTS.filter((e) => e.kind === "event").map((e) => ({
    id: e.id,
    name: text(e.name),
    sub: (e.where || []).map(text).join(" / "),
  }));
  const groups = [
    { key: "elyos", title: "World bosses · Verteron (Elyos)", items: world("elyos") },
    { key: "asmodian", title: "World bosses · Altgard (Asmodian)", items: world("asmodian") },
    { key: "abyss", title: "Abyss bosses · Lower Reshanta", items: abyss },
    { key: "events", title: "Events", items: events },
  ];
  if (side === "asmodian") groups.unshift(groups.splice(1, 1)[0]);
  return groups;
}

const tracked = () => (prefs.tracked ||= {});
const isTracked = (id) => !!tracked()[id];

// Track it or not. Tracking turns its popup on (its alert, at the default
// time); not tracking turns it off, so nothing untracked pops up.
function setTracked(id, on) {
  if (on) {
    tracked()[id] = true;
    if (!(id in prefs.alerts)) prefs.alerts[id] = prefs.leads[id] ?? defaultLead();
  } else {
    delete tracked()[id];
    delete prefs.alerts[id];
  }
}

// From before tracking: what had an alert is tracked. "All field bosses"
// gave every world boss an alert and an icon; it goes, as the list now
// shows what is chosen.
function migrateTracking() {
  if (prefs.tracked) return;
  prefs.tracked = {};
  for (const id of Object.keys(prefs.alerts || {})) {
    if (id === ALL_FIELD || EVENTS.some((e) => e.id === id && e.kind === "reset")) continue;
    prefs.tracked[id] = true;
  }
  delete prefs.alerts[ALL_FIELD];
  savePrefs();
}

let setupMode = false;

function renderTrack() {
  const view = els.views.track;
  if (!view) return;
  const keepScroll = view.scrollTop;
  const count = Object.keys(tracked()).length;
  const groups = trackGroups();
  const lead = defaultLead();
  view.innerHTML = `
    ${setupMode ? `<div class="trackIntro setup"><b>Pick what you want to follow.</b> Only what you tick shows in the Timers list over the game, and gets a popup ${lead} min before it starts. Leave the rest: you can change this any time on this tab.</div>`
      : `<div class="trackIntro">${count ? `Tracking ${count}.` : "Nothing tracked yet."} What you tick shows in the Timers list over the game, and gets a popup ${lead} min before it starts (the bell; untick it for the list only).</div>`}
    ${groups.map((g) => {
      const on = g.items.filter((it) => isTracked(it.id)).length;
      return `<details class="trackGroup" data-group="${g.key}" ${prefs.trackOpen?.[g.key] ?? (on || g.key === groups[0].key) ? "open" : ""}>
        <summary><span class="tgTitle">${g.title}</span><span class="tgCount">${on ? `${on} of ${g.items.length}` : `${g.items.length}`}</span>
          <button type="button" class="btn small tgAll" data-group="${g.key}">${on === g.items.length ? "None" : "All"}</button></summary>
        <ul class="trackList">${g.items.map((it) => {
          const t = isTracked(it.id);
          const bell = !!bossAlert(it.id).state || it.id in prefs.alerts;
          return `<li class="trackRow${t ? " on" : ""}">
            <label><input type="checkbox" data-track="${it.id}" ${t ? "checked" : ""} /><span class="trName">${it.name}</span><span class="trSub">${it.sub}</span></label>
            <button type="button" class="trBell${bell ? " on" : ""}" data-bell="${it.id}" ${t ? "" : "disabled"} title="${bell ? "Popup on: click for the list only" : "List only: click for a popup too"}">${BELL_ICON}</button>
          </li>`;
        }).join("")}</ul>
      </details>`;
    }).join("")}
    <p class="note">The popups come over the game (Notices), and as a desktop notification while AION 2 is closed. Their time and sound are under Alerts.</p>`;
  view.scrollTop = keepScroll;
}

// The Track tab's clicks: tick, bell, all or none, a group folded.
(() => {
  const view = els.views.track;
  if (!view) return;
  view.addEventListener("change", (e) => {
    const id = e.target?.dataset?.track;
    if (!id) return;
    setTracked(id, e.target.checked);
    savePrefs();
    renderTrack();
    renderAlerts();
    if (typeof sendBossList === "function") sendBossList();
  });
  view.addEventListener("click", (e) => {
    const bell = e.target.closest?.("[data-bell]");
    if (bell) {
      const id = bell.dataset.bell;
      if (id in prefs.alerts) delete prefs.alerts[id];
      else prefs.alerts[id] = prefs.leads[id] ?? defaultLead();
      savePrefs();
      renderTrack();
      renderAlerts();
      if (typeof sendBossList === "function") sendBossList();
      return;
    }
    const all = e.target.closest?.(".tgAll");
    if (all) {
      e.preventDefault();
      const g = trackGroups().find((x) => x.key === all.dataset.group);
      if (!g) return;
      const every = g.items.every((it) => isTracked(it.id));
      for (const it of g.items) setTracked(it.id, !every);
      savePrefs();
      renderTrack();
      renderAlerts();
      if (typeof sendBossList === "function") sendBossList();
    }
  });
  view.addEventListener("toggle", (e) => {
    const g = e.target?.dataset?.group;
    if (!g) return;
    prefs.trackOpen = { ...(prefs.trackOpen || {}), [g]: e.target.open };
    savePrefs();
  }, true);
})();

// The dashboard's setup: straight to this tab, with its intro.
a2.on("setup", (d) => {
  setupMode = d?.active !== false;
  if (setupMode) {
    prefs.tab = "track";
    renderTabs();
  }
  renderTrack();
});

// Drawn when its tab opens, and when the character (its side) is known.
for (const tab of els.tabs) tab.addEventListener("click", () => tab.dataset.tab === "track" && renderTrack());
a2.on("character", () => setTimeout(renderTrack, 0));
// Drawn once plugin.js has read the settings (it migrates them first).
setTimeout(function first() {
  if (!prefs.tracked) return void setTimeout(first, 200);
  renderTrack();
}, 0);
