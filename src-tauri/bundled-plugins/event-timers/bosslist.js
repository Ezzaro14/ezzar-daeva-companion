// Timers over the game (fork): one list on the overlay of what the player
// tracks (tracking.js), folded to one line ("1 up · next Rotten Kutar in
// 8:54") or open, as the player leaves it. It takes clicks even while the overlay is locked, so it can be opened
// and closed in play. Its bells are the Bosses tab's: a boss with one on
// gets a popup before it spawns (checkAlerts, as Notices in the dashboard).
// Uses plugin.js's helpers (fieldBosses, fieldTimer, scheduled, nextOf, …).

const BOSS_LIST = "bosses";
// How many it lists when open (Settings → Timers list), 20 unless changed.
const BOSS_LIST_ROWS = [5, 10, 15, 20];
const listRows = () => (BOSS_LIST_ROWS.includes(Number(prefs.bossListRows)) ? Number(prefs.bossListRows) : 20);
// Folded, with "what is near" picked: what is up, or starts within this.
const NEAR_MS = 30 * 60_000;
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
  // Unless the player asks for what is near too (Settings → Timers list).
  const near = prefs.bossListFolded === "near";
  for (const r of rows) r.near = near && (r.group !== "upcoming" || r.sort - now <= NEAR_MS);
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
    rows: rows.slice(0, listRows()).map((r) => ({ ...r, at: r.at ? fmt.format(new Date(r.at)) : "" })),
    more: Math.max(0, rows.length - listRows()),
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
    // The fold the click left it in, not "the other one": a message heard
    // twice folded it straight back. A widget from before says only toggle.
    prefs.bossListExpanded = typeof d.expanded === "boolean" ? d.expanded : !prefs.bossListExpanded;
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

// Settings in two parts: the Timers list's own, first, then the popups'
// (the alerts' settings under their own headings). Drawn by renderStatic.
function renderBossListSettings() {
  const view = document.querySelector(".view.settings");
  if (!view) return;
  let box = view.querySelector(".listSettings");
  if (!box) {
    box = document.createElement("div");
    box.className = "listSettings";
    box.innerHTML = `
      <h2 class="group part">Timers list</h2>
      <p class="note">What you track (the Track tab), in one list over the game. Click its title in game to open or fold it.</p>
      <label class="setting"><span>Show it over the game</span> <input type="checkbox" class="listOn switch" role="switch" /></label>
      <label class="setting listMore"><span>Folded, it shows</span> <select class="listFolded">
        <option value="next">The next timer</option><option value="near">What's up or within 30 min</option></select></label>
      <label class="setting listMore"><span>Open, it lists</span> <select class="listRows">
        ${BOSS_LIST_ROWS.map((n) => `<option value="${n}">Up to ${n}</option>`).join("")}</select></label>
      <h2 class="group part">Popups</h2>
      <p class="note">Before what you track starts. A timer's bell, on the list or the Bosses tab, turns its popup on or off.</p>`;
    view.prepend(box);
    const changed = () => {
      savePrefs();
      renderBossListSettings();
      sendBossList();
    };
    box.querySelector(".listOn").addEventListener("change", (e) => {
      prefs.bossList = e.target.checked;
      changed();
    });
    box.querySelector(".listFolded").addEventListener("change", (e) => {
      prefs.bossListFolded = e.target.value;
      changed();
    });
    box.querySelector(".listRows").addEventListener("change", (e) => {
      prefs.bossListRows = Number(e.target.value);
      changed();
    });
  }
  const on = prefs.bossList !== false;
  box.querySelector(".listOn").checked = on;
  box.querySelector(".listFolded").value = prefs.bossListFolded === "near" ? "near" : "next";
  box.querySelector(".listRows").value = String(listRows());
  for (const row of box.querySelectorAll(".listMore")) row.hidden = !on;
}

setInterval(sendBossList, 1000);
