// Timers over the game (fork): one list on the overlay of what the player
// tracks (tracking.js), folded to one line ("1 up · next Rotten Kutar in
// 8:54") or open, as the player leaves it. It takes clicks even while the overlay is locked, so it can be opened
// and closed in play. Its bells are the Bosses tab's: a boss with one on
// gets a popup before it spawns (checkAlerts, as Notices in the dashboard).
// Uses plugin.js's helpers (fieldBosses, fieldTimer, scheduled, nextOf, …).

const BOSS_LIST = "bosses";
const BOSS_LIST_ROWS = 20;
const BOSS_LIST_SIZE = { width: 340, height: 470 };

let bossListOpen = false; // the widget is open on the overlay
let bossListSent = "";

// What is tracked (tracking.js), with something to say: up or on now, in
// its spawn window, or coming, the soonest first; and how many tracked
// bosses have no timer yet.
function bossListRows(now) {
  const words = ui();
  const rows = [];
  let unknown = 0;
  const tz = timeZone();
  for (const id of Object.keys(prefs.tracked || {})) {
    const alert = !!bossAlert(id).state;
    if (id.startsWith("field:")) {
      const b = FIELD_BOSSES[id.slice(6)];
      if (!b) continue;
      const t = fieldTimer(id.slice(6));
      const next = t?.state === "dead" && t.nextSpawn ? t.nextSpawn * 1000 : null;
      const base = { id, name: text(b.name), where: text(b.where), level: b.level || null, alert, tag: b.side ? "" : "Abyss" };
      if (t?.state === "up") {
        const hp = t.hp != null && t.hpAt && now - t.hpAt * 1000 < 30 * 60_000 ? Math.max(0, Math.min(100, t.hp)) : null;
        rows.push({ ...base, group: "up", sort: hp ?? 101, when: t.upSince ? words.upFor(span(now - t.upSince * 1000)) : words.up, hp });
      } else if (next && next <= now && now - next <= WINDOW_MS) {
        rows.push({ ...base, group: "window", sort: next, when: words.ago(age(now - next)) });
      } else if (next && next > now) {
        rows.push({ ...base, group: "upcoming", sort: next, at: next, when: words.in(span(next - now)), soon: next - now <= SOON_MS });
      } else {
        unknown++;
      }
      continue;
    }
    const ev = EVENTS.find((e) => e.id === id);
    if (!ev || (!tz && !ev.utc)) continue;
    const next = nextOf(ev, tz || "UTC", now);
    if (!next) continue;
    const base = { id, name: text(ev.name), where: (ev.where || []).map(text).join(" / "), level: null, alert, tag: ev.kind === "boss" ? "Abyss" : "Event" };
    if (next.start <= now && next.end > now) rows.push({ ...base, group: "up", sort: 102, when: words.left(span(next.end - now)) });
    else rows.push({ ...base, group: "upcoming", sort: next.start, at: next.start, when: words.in(span(next.start - now)), soon: next.start - now <= SOON_MS });
  }
  const order = { up: 0, window: 1, upcoming: 2 };
  rows.sort((a, b) => order[a.group] - order[b.group] || a.sort - b.sort || a.name.localeCompare(b.name));
  return { rows, unknown };
}

async function sendBossList() {
  const want = prefs.bossList !== false && typeof a2.widgets?.open === "function";
  if (!want) {
    if (bossListOpen) {
      bossListOpen = false;
      bossListSent = "";
      await a2.widgets.close(BOSS_LIST).catch(() => {});
    }
    return;
  }
  if (!bossListOpen) {
    bossListOpen = await a2.widgets
      .open(BOSS_LIST, { ...BOSS_LIST_SIZE, label: "Timers", clickable: true })
      .then(() => true, () => false);
    if (!bossListOpen) return;
    bossListSent = "";
  }
  const now = Date.now();
  const { rows, unknown } = bossListRows(now);
  // Folded is one line, whatever comes up: the list opens only when the
  // player opens it (it grew and shrank by itself as bosses came and went).
  for (const r of rows) r.near = false;
  const up = rows.filter((r) => r.group === "up").length;
  const next = rows.find((r) => r.group === "upcoming");
  const fmt = clock();
  const data = {
    kind: "bosslist",
    expanded: !!prefs.bossListExpanded,
    title: "Timers",
    tracked: Object.keys(prefs.tracked || {}).length,
    up,
    next: next ? { name: next.name, when: next.when, soon: !!next.soon } : null,
    rows: rows.slice(0, BOSS_LIST_ROWS).map((r) => ({ ...r, at: r.at ? fmt.format(new Date(r.at)) : "" })),
    more: Math.max(0, rows.length - BOSS_LIST_ROWS),
    unknown,
    noServer: !serverId(),
    lead: defaultLead(),
  };
  const key = JSON.stringify(data);
  if (key === bossListSent) return;
  bossListSent = key;
  a2.widgets.send(BOSS_LIST, data).catch(() => {});
}

a2.on("widget-message", (msg) => {
  if (msg?.name !== BOSS_LIST) return;
  const d = msg.data || {};
  if (d.toggle) {
    prefs.bossListExpanded = !prefs.bossListExpanded;
    savePrefs();
  } else if (typeof d.bossAlert === "string") {
    toggleBossAlert(d.bossAlert);
  } else if (d.open && typeof windowApi === "function" && windowApi()) {
    // Nothing tracked yet: the Track tab.
    if (d.track) {
      prefs.tab = "track";
      renderTabs();
      if (typeof renderTrack === "function") renderTrack();
    }
    windowApi().show().catch(() => {});
  }
  sendBossList();
});

// The Bosses tab's switch for it.
(() => {
  const view = document.querySelector(".view.bosses");
  if (!view) return;
  const label = document.createElement("label");
  label.className = "bossListToggle";
  label.innerHTML = '<input type="checkbox" class="bossListOn" /> <span><b>Show the Timers list over the game</b><small>What you track (the Track tab), in one list. Click its title in game to open or close it.</small></span>';
  view.prepend(label);
  const box = label.querySelector("input");
  box.addEventListener("change", () => {
    prefs.bossList = box.checked;
    savePrefs();
    sendBossList();
  });
  const sync = () => (box.checked = prefs.bossList !== false);
  setTimeout(sync, 0);
  setInterval(sync, 5000);
})();

setInterval(sendBossList, 1000);
