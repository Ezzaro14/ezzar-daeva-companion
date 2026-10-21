// Dungeon Runs: a run is a visit to a dungeon (snapshot.dungeon, from entry
// to leaving), with the boss fights the meter saved there (a2.on("fight"))
// and each member's numbers added up across them.
const $ = (s) => document.querySelector(s);

const MAX_RUNS = 100;
const STORE_BYTES = 900_000;

let runs = [];
let current = null; // { dungeonId, name, difficulty, enteredMs, fights: { id: fight } }
let tab = "current";
let detail = null;

const saveRuns = () => a2.storage.set("runs", runs).catch(() => {});
const saveCurrent = () => a2.storage.set("current", current).catch(() => {});

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
};
const when = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const DIFFICULTY = { normal: "Normal", hard: "Hard", exploration: "Exploration", conquest: "Conquest" };
const titleOf = (r) => `${r.name || `Dungeon ${r.dungeonId}`}${r.difficulty ? ` (${DIFFICULTY[r.difficulty] || r.difficulty})` : ""}`;

// ── a run's numbers ─────────────────────────────────────────────────────────

function summary(run) {
  const fights = Object.values(run.fights).sort((a, b) => a.startMs - b.startMs);
  const members = new Map();
  for (const f of fights) {
    for (const p of f.players || []) {
      const m = members.get(p.name) || { name: p.name, classId: p.classId, damage: 0, timeMs: 0, deaths: 0, me: false };
      m.damage += p.damage || 0;
      m.timeMs += f.durationMs;
      m.deaths += p.deaths || 0;
      m.me ||= !!p.me;
      m.classId ||= p.classId;
      members.set(p.name, m);
    }
  }
  const list = [...members.values()].map((m) => ({ ...m, dps: m.damage / Math.max(1, m.timeMs / 1000) })).sort((a, b) => b.damage - a.damage);
  const last = fights[fights.length - 1];
  const endMs = run.leftMs || (last ? last.startMs + last.durationMs : run.enteredMs);
  return {
    fights,
    members: list,
    clearMs: last ? last.startMs + last.durationMs - run.enteredMs : 0,
    totalMs: endMs - run.enteredMs,
    deaths: list.reduce((n, m) => n + m.deaths, 0),
  };
}

// One line for the game's chat: the run, its time, each member's DPS.
function chatLine(run) {
  const s = summary(run);
  const members = s.members.map((m) => `${m.name} ${k(m.dps)}`).join(" · ");
  return `${titleOf(run)} ${clock(s.clearMs)} — ${members}${s.deaths ? ` — ${s.deaths} deaths` : ""}`;
}

function classIcon(id) {
  const img = new Image();
  img.className = "cls";
  img.src = CLASS_ICONS[id] || "";
  img.title = CLASS_NAMES[id] || "";
  if (!CLASS_ICONS[id]) img.style.visibility = "hidden";
  return img;
}

function cell(text, cls = "") {
  return Object.assign(document.createElement("td"), { textContent: text, className: cls });
}

function renderRun(el, run, live) {
  const s = summary(run);
  const head = document.createElement("div");
  head.className = "stats";
  const stat = (label, v) => {
    const span = document.createElement("span");
    span.append(`${label} `, Object.assign(document.createElement("b"), { textContent: v }));
    return span;
  };
  head.append(
    Object.assign(document.createElement("b"), { textContent: titleOf(run) }),
    Object.assign(stat(live ? "In for" : "Run", clock(live ? Date.now() - run.enteredMs + (run.offset || 0) : s.totalMs)), { className: live ? "liveClock" : "" }),
    stat("Clear time", s.fights.length ? clock(s.clearMs) : "–"),
    stat("Bosses", String(s.fights.length)),
    stat("Deaths", String(s.deaths)),
  );
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn small";
  copy.textContent = "Copy for chat";
  copy.disabled = !s.fights.length;
  copy.addEventListener("click", async () => {
    try {
      await a2.copy(chatLine(run));
      copy.textContent = "Copied";
    } catch (e) {
      copy.textContent = "Couldn't copy";
    }
    setTimeout(() => (copy.textContent = "Copy for chat"), 1500);
  });
  head.append(copy);

  const members = document.createElement("table");
  members.className = "table";
  members.innerHTML = '<thead><tr><th>Member</th><th class="r">Damage</th><th class="r">DPS</th><th class="r">Deaths</th></tr></thead>';
  const mb = document.createElement("tbody");
  for (const m of s.members) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "skill";
    name.append(classIcon(m.classId), m.name + (m.me ? " (you)" : ""));
    tr.append(name, cell(k(m.damage), "r"), cell(k(m.dps), "r"), cell(String(m.deaths), "r"));
    mb.append(tr);
  }
  members.append(mb);

  const fights = document.createElement("table");
  fights.className = "table";
  fights.innerHTML = '<thead><tr><th>Boss</th><th class="r">Time</th><th class="r">Your DPS</th><th class="r">Party DPS</th></tr></thead>';
  const fb = document.createElement("tbody");
  for (const f of s.fights) {
    const tr = document.createElement("tr");
    const party = (f.players || []).reduce((n, p) => n + (p.dps || 0), 0);
    tr.append(cell(f.boss), cell(clock(f.durationMs), "r"), cell(f.me ? k(f.me.dps) : "–", "r"), cell(k(party), "r"));
    fb.append(tr);
  }
  fights.append(fb);

  el.replaceChildren(head, ...(s.fights.length ? [members, Object.assign(document.createElement("h3"), { textContent: "Boss fights" }), fights] : []));
}

// ── keeping runs ────────────────────────────────────────────────────────────

function finish(leftMs) {
  if (current && Object.keys(current.fights).length) {
    const run = { ...current, id: `run${current.enteredMs}`, leftMs };
    runs = [run, ...runs.filter((r) => r.id !== run.id)].slice(0, MAX_RUNS);
    while (runs.length > 1 && JSON.stringify(runs).length > STORE_BYTES) runs.pop();
    saveRuns();
  }
  current = null;
  saveCurrent();
}

let lastDungeon = null;
a2.on("combat", (s) => {
  const d = s.dungeon;
  const id = d ? d.id : 0;
  const offset = Date.now() - s.nowMs;
  if (id !== lastDungeon) {
    lastDungeon = id;
    // Left it (a run kept from before a restart of the meter goes on while
    // you are still in its dungeon).
    if (current && current.dungeonId !== id) finish(s.nowMs);
    if (d && !current) {
      current = { dungeonId: id, name: d.name, difficulty: d.difficulty, enteredMs: d.enteredMs, fights: {} };
      saveCurrent();
    }
    render();
  }
  if (current) current.offset = -offset;
  $(".status").textContent = d ? `In ${titleOf(current || { ...d, dungeonId: d.id })}` : "Not in a dungeon";
});

a2.on("fight", (f) => {
  if (!current || f.isTrain || f.dungeonId !== current.dungeonId) return;
  current.fights[f.id] = f;
  saveCurrent();
  if (tab === "current") render();
});

// ── the page ────────────────────────────────────────────────────────────────

function render() {
  for (const b of document.querySelectorAll(".chips button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll(".view")) v.hidden = !v.classList.contains(tab);
  if (tab === "current") {
    $(".currentEmpty").hidden = !!current;
    if (current) renderRun($(".currentRun"), current, true);
    else $(".currentRun").replaceChildren();
    return;
  }
  const r = runs.find((x) => x.id === detail);
  $(".pastDetail").hidden = !r;
  $(".runList").hidden = !!r;
  $(".pastEmpty").hidden = !!r || runs.length > 0;
  if (r) return renderRun($(".pastRun"), r, false);
  $(".runList").replaceChildren(
    ...runs.map((run) => {
      const s = summary(run);
      const li = document.createElement("li");
      li.className = "item";
      const info = Object.assign(document.createElement("span"), { className: "grow", textContent: titleOf(run) });
      info.append(
        document.createElement("br"),
        Object.assign(document.createElement("span"), {
          className: "sub",
          textContent: `${when(run.enteredMs)} · ${s.fights.length} bosses · ${s.deaths} deaths`,
        }),
      );
      li.append(info, Object.assign(document.createElement("span"), { className: "num", textContent: clock(s.clearMs) }));
      li.addEventListener("click", () => {
        detail = run.id;
        render();
      });
      return li;
    }),
  );
}

for (const b of document.querySelectorAll(".chips button")) {
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    detail = null;
    render();
  });
}
$(".back").addEventListener("click", () => {
  detail = null;
  render();
});
$(".deleteRun").addEventListener("click", () => {
  runs = runs.filter((r) => r.id !== detail);
  detail = null;
  saveRuns();
  render();
});
a2.on("compact", (on) => document.body.classList.toggle("compact", !!on));
// The live run's clock.
setInterval(() => {
  const el = document.querySelector(".liveClock b");
  if (el && current) el.textContent = clock(Date.now() - current.enteredMs + (current.offset || 0));
}, 1000);

(async () => {
  runs = (await a2.storage.get("runs").catch(() => null)) || [];
  current = await a2.storage.get("current").catch(() => null);
  render();
  a2.ready();
})();
