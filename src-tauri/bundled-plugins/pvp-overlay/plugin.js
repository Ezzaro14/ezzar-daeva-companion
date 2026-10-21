// PvP Overlay: the players you trade blows with, live in a widget and here,
// and each session saved with its opponents, their skills and the damage over
// time. Reads the combat feed's `pvp` (combat/combat_feed.rs).
const $ = (s) => document.querySelector(s);

const DEFAULTS = { show: true, onlyActive: true, rows: 6, killSound: "rise", keep: 50 };
// A point of the damage-over-time chart every this many ms.
const SAMPLE_MS = 2000;

let prefs = { ...DEFAULTS };
let sessions = [];
let snap = null;
let tab = "live";
let open = null; // the opponent unfolded in a list, by id
let detail = null; // the session shown

// The session being recorded: its start, samples, and the last state.
let rec = null;

const save = () => a2.storage.set("prefs", prefs).catch(() => {});
const saveSessions = () => a2.storage.set("sessions", sessions).catch(() => {});

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const when = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function classIcon(id) {
  const el = document.createElement("span");
  el.className = "cls";
  if (CLASS_ICONS[id]) {
    const img = new Image();
    img.src = CLASS_ICONS[id];
    img.alt = CLASS_NAMES[id] || "";
    img.title = CLASS_NAMES[id] || "";
    el.append(img);
  }
  return el;
}

// ── recording ───────────────────────────────────────────────────────────────

function sessionOf(pvp, samples) {
  return {
    id: `${pvp.sinceMs}`,
    startMs: pvp.sinceMs,
    endMs: pvp.lastMs,
    kills: pvp.kills,
    deaths: pvp.deaths,
    burst: pvp.burst,
    dealt: pvp.dealt,
    taken: pvp.taken,
    opponents: pvp.opponents.map((o) => ({
      name: o.name,
      classId: o.classId,
      dealt: o.dealt,
      taken: o.taken,
      killed: o.killed,
      hitsDealt: o.hitsDealt,
      hitsTaken: o.hitsTaken,
      skillsDealt: o.skillsDealt,
      skillsTaken: o.skillsTaken,
      series: samples.byOpponent[o.id] || [],
    })),
    series: samples.total,
  };
}

let lastStore = 0;
function record(pvp) {
  if (!pvp || !pvp.session) return;
  if (!rec || rec.session !== pvp.session) {
    if (rec?.last) finish(rec.last, rec);
    rec = { session: pvp.session, total: [], byOpponent: {}, lastSample: 0, kills: pvp.kills, last: null };
  }
  rec.last = pvp;
  if (pvp.active && Date.now() - rec.lastSample >= SAMPLE_MS) {
    rec.lastSample = Date.now();
    const t = Math.max(0, (snap.nowMs - pvp.sinceMs) / 1000);
    rec.total.push([Math.round(t), pvp.dealt, pvp.taken]);
    for (const o of pvp.opponents) (rec.byOpponent[o.id] ||= []).push([Math.round(t), o.dealt, o.taken]);
  }
  if (pvp.kills > rec.kills) {
    rec.kills = pvp.kills;
    playSound(prefs.killSound);
  }
  // Kept as it goes, so a session survives the meter closing mid-fight.
  if (pvp.active && Date.now() - lastStore > 10000 && (pvp.dealt || pvp.taken)) {
    lastStore = Date.now();
    store(sessionOf(pvp, rec));
  }
  if (!pvp.active && rec.last && !rec.done) {
    rec.done = true;
    finish(pvp, rec);
  }
}

function finish(pvp, samples) {
  if (!(pvp.dealt || pvp.taken)) return;
  store(sessionOf(pvp, samples));
}

// At most `n` points, every so many taken, the last always kept.
function thin(series, n) {
  if (!series || series.length <= n) return series || [];
  const step = series.length / n;
  const out = [];
  for (let i = 0; i < n - 1; i++) out.push(series[Math.floor(i * step)]);
  out.push(series[series.length - 1]);
  return out;
}

// The plugin's store holds up to 1 MB a key: the oldest sessions go first.
const STORE_BYTES = 900_000;
function store(session) {
  session.series = thin(session.series, 150);
  for (const o of session.opponents) o.series = thin(o.series, 60);
  sessions = [session, ...sessions.filter((s) => s.id !== session.id)].slice(0, prefs.keep);
  while (sessions.length > 1 && JSON.stringify(sessions).length > STORE_BYTES) sessions.pop();
  saveSessions();
  if (tab === "sessions" && !detail) renderSessions();
}

// ── the widget ──────────────────────────────────────────────────────────────

const widgetHeight = () => 30 + prefs.rows * 24 + 6;
let widgetOpen = false;
async function placeWidget() {
  const want = prefs.show && (!prefs.onlyActive || !!snap?.pvp?.active || editing);
  if (want && !widgetOpen) {
    await a2.widgets.open("pvp", { width: 320, height: widgetHeight() }).catch(() => {});
    widgetOpen = true;
  } else if (!want && widgetOpen) {
    await a2.widgets.close("pvp").catch(() => {});
    widgetOpen = false;
  }
  sendWidget();
}

function sendWidget() {
  if (!widgetOpen) return;
  const pvp = snap?.pvp;
  a2.widgets
    .send("pvp", {
      active: !!pvp?.active,
      since: pvp?.session ? pvp.sinceMs : null,
      now: snap?.nowMs,
      last: pvp?.lastMs,
      kills: pvp?.kills || 0,
      deaths: pvp?.deaths || 0,
      burst: pvp?.burst || 0,
      rows: (pvp?.opponents || []).slice(0, prefs.rows).map((o) => ({
        name: o.name || `#${o.id}`,
        icon: CLASS_ICONS[o.classId] || null,
        dealt: o.dealt,
        taken: o.taken,
        hp: o.hp,
        down: o.dead,
        killed: o.killed,
      })),
    })
    .catch(() => {});
}

// ── the page ────────────────────────────────────────────────────────────────

function statsEl(el, s, live) {
  const parts = [
    ["Time", clock((live ? s.lastMs : s.endMs) - (live ? s.sinceMs : s.startMs))],
    ["Kills", s.kills],
    ["Deaths", s.deaths],
    ["Dealt", k(s.dealt)],
    ["Taken", k(s.taken)],
    ["Biggest burst (5 s)", k(s.burst)],
  ];
  el.replaceChildren(
    ...parts.map(([label, v]) => {
      const span = document.createElement("span");
      span.append(`${label} `, Object.assign(document.createElement("b"), { textContent: String(v) }));
      return span;
    }),
  );
}

function skillsEl(o) {
  const box = document.createElement("div");
  box.className = "skills";
  for (const [title, list] of [["Your skills on them", o.skillsDealt], ["Their skills on you", o.skillsTaken]]) {
    const col = document.createElement("div");
    col.style.display = "block";
    col.append(Object.assign(document.createElement("h4"), { textContent: title }));
    for (const sk of list || []) {
      const row = document.createElement("div");
      row.append(Object.assign(document.createElement("span"), { textContent: sk.name || `#${sk.skill}` }), Object.assign(document.createElement("span"), { textContent: k(sk.damage) }));
      col.append(row);
    }
    if (!(list || []).length) col.append(Object.assign(document.createElement("div"), { textContent: "–" }));
    box.append(col);
  }
  return box;
}

function opponentRow(o, key) {
  const li = document.createElement("li");
  li.className = `item${o.killed ? " killed" : ""}`;
  const name = Object.assign(document.createElement("span"), { className: "grow", textContent: o.name || "Unknown" });
  if (o.dead && !o.killed) name.append(" ", Object.assign(document.createElement("span"), { className: "badge", textContent: "down" }));
  li.append(classIcon(o.classId), name);
  if (typeof o.hp === "number" && !o.killed && !o.dead) li.append(Object.assign(document.createElement("span"), { className: "num", textContent: `${k(o.hp)} HP` }));
  li.append(
    Object.assign(document.createElement("span"), { className: "num dealt", textContent: k(o.dealt), title: "You dealt" }),
    Object.assign(document.createElement("span"), { className: "num taken", textContent: k(o.taken), title: "You took" }),
  );
  if (open === key) li.append(skillsEl(o));
  li.addEventListener("click", () => {
    open = open === key ? null : key;
    if (detail) renderDetail();
    else renderLive();
  });
  return li;
}

function renderLive() {
  const pvp = snap?.pvp;
  const has = pvp && pvp.session > 0 && pvp.opponents.length;
  $(".liveEmpty").hidden = !!has;
  if (!has) {
    $(".liveStats").replaceChildren();
    $(".liveList").replaceChildren();
    return;
  }
  statsEl($(".liveStats"), pvp, true);
  $(".liveList").replaceChildren(...pvp.opponents.map((o) => opponentRow(o, `live:${o.id}`)));
}

function renderSessions() {
  $(".sessionDetail").hidden = !detail;
  $(".sessionList").hidden = !!detail;
  $(".sessionsEmpty").hidden = !!detail || sessions.length > 0;
  if (detail) return renderDetail();
  $(".sessionList").replaceChildren(
    ...sessions.map((s) => {
      const li = document.createElement("li");
      li.className = "item";
      const info = Object.assign(document.createElement("span"), { className: "grow", textContent: when(s.startMs) });
      info.append(
        document.createElement("br"),
        Object.assign(document.createElement("span"), {
          className: "sub",
          textContent: `${clock(s.endMs - s.startMs)} · ${s.opponents.length} opponents · ${s.kills} kills · ${s.deaths} deaths · burst ${k(s.burst)}`,
        }),
      );
      li.append(info,
        Object.assign(document.createElement("span"), { className: "num dealt", textContent: k(s.dealt) }),
        Object.assign(document.createElement("span"), { className: "num taken", textContent: k(s.taken) }));
      li.addEventListener("click", () => {
        detail = s.id;
        open = null;
        renderSessions();
      });
      return li;
    }),
  );
}

function renderDetail() {
  const s = sessions.find((x) => x.id === detail);
  if (!s) {
    detail = null;
    return renderSessions();
  }
  statsEl($(".detailStats"), s, false);
  $(".detailList").replaceChildren(...s.opponents.map((o, i) => opponentRow(o, `s:${i}`)));
  const shown = open?.startsWith("s:") ? s.opponents[Number(open.slice(2))] : null;
  drawChart($(".chart"), shown ? shown.series : s.series);
}

// Damage per second over the session: the difference between samples.
function drawChart(canvas, series) {
  const ctx = canvas.getContext("2d");
  const W = (canvas.width = canvas.clientWidth * devicePixelRatio || 420);
  const H = (canvas.height = 140 * devicePixelRatio);
  ctx.clearRect(0, 0, W, H);
  if (!series || series.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = `${12 * devicePixelRatio}px sans-serif`;
    ctx.fillText("Not enough data for a chart", 10 * devicePixelRatio, 20 * devicePixelRatio);
    return;
  }
  const rates = [];
  for (let i = 1; i < series.length; i++) {
    const dt = Math.max(1, series[i][0] - series[i - 1][0]);
    rates.push([series[i][0], (series[i][1] - series[i - 1][1]) / dt, (series[i][2] - series[i - 1][2]) / dt]);
  }
  const tMax = Math.max(1, rates[rates.length - 1][0]);
  const vMax = Math.max(1, ...rates.map((r) => Math.max(r[1], r[2])));
  const pad = 6 * devicePixelRatio;
  for (const [idx, color] of [[1, "#ffb36b"], [2, "#8fc2ff"]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.beginPath();
    rates.forEach((r, i) => {
      const x = pad + (r[0] / tMax) * (W - 2 * pad);
      const y = H - pad - (r[idx] / vMax) * (H - 2 * pad);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.font = `${10 * devicePixelRatio}px sans-serif`;
  ctx.fillText(`${k(vMax)}/s`, pad, pad + 8 * devicePixelRatio);
}

function renderTabs() {
  for (const b of document.querySelectorAll(".chips button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll(".view")) v.hidden = !v.classList.contains(tab);
}

function renderStatus() {
  const pvp = snap?.pvp;
  $(".status").textContent = pvp?.active ? `In PvP for ${clock(pvp.lastMs - pvp.sinceMs)}` : sessions.length ? `${sessions.length} sessions saved` : "No PvP yet";
  $(".status").classList.toggle("hot", !!pvp?.active);
}

// ── events ──────────────────────────────────────────────────────────────────

let liveRender = 0;
a2.on("combat", (s) => {
  const was = !!snap?.pvp?.active;
  snap = s;
  record(s.pvp);
  if (!!s.pvp?.active !== was) placeWidget();
  else sendWidget();
  renderStatus();
  if (tab === "live" && Date.now() - liveRender > 500) {
    liveRender = Date.now();
    renderLive();
  }
});
a2.on("locked", (on) => {
  $(".lock").checked = !!on;
});
a2.on("widget-message", ({ data }) => {
  if (data?.open) a2.window?.show?.();
});
a2.on("compact", (on) => document.body.classList.toggle("compact", !!on));
a2.on("hosted", () => document.body.classList.add("hosted"));
// Edit layout (the dashboard): the overlay shows even outside PvP.
let editing = false;
a2.on("layout", (o) => {
  editing = !!o?.editing;
  placeWidget();
});

for (const b of document.querySelectorAll(".chips button")) {
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    renderTabs();
    if (tab === "sessions") renderSessions();
    if (tab === "live") renderLive();
  });
}
$(".back").addEventListener("click", () => {
  detail = null;
  open = null;
  renderSessions();
});
$(".deleteSession").addEventListener("click", () => {
  sessions = sessions.filter((s) => s.id !== detail);
  detail = null;
  saveSessions();
  renderSessions();
});
$(".lock").addEventListener("change", () => a2.widgets.lock($(".lock").checked).catch(() => {}));
const bind = (sel, key, read) =>
  $(sel).addEventListener("change", () => {
    prefs[key] = read($(sel));
    save();
    widgetOpen && key === "rows" ? a2.widgets.open("pvp", { width: 320, height: widgetHeight() }).then(sendWidget).catch(() => {}) : placeWidget();
  });
bind(".show", "show", (el) => el.checked);
bind(".onlyActive", "onlyActive", (el) => el.checked);
bind(".rows", "rows", (el) => Math.max(1, Math.min(12, Math.round(Number(el.value) || 6))));
bind(".killSound", "killSound", (el) => el.value);
bind(".keep", "keep", (el) => Math.max(5, Math.min(200, Math.round(Number(el.value) || 50))));

(async () => {
  $(".killSound").replaceChildren(...Object.entries(SOUND_NAMES).map(([v, t]) => Object.assign(document.createElement("option"), { value: v, textContent: t })));
  const stored = await a2.storage.get("prefs").catch(() => null);
  if (stored && typeof stored === "object") prefs = { ...DEFAULTS, ...stored };
  sessions = (await a2.storage.get("sessions").catch(() => null)) || [];
  $(".show").checked = prefs.show;
  $(".onlyActive").checked = prefs.onlyActive;
  $(".rows").value = prefs.rows;
  $(".killSound").value = prefs.killSound;
  $(".keep").value = prefs.keep;
  $(".lock").checked = await a2.widgets.locked().catch(() => false);
  renderTabs();
  renderLive();
  renderStatus();
  await placeWidget();
  a2.ready();
})();
