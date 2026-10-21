// Daily Planner: what to do each day and each week, counted per character,
// reset at the game's resets, with a notice before a reset while something
// is left.
const $ = (s) => document.querySelector(s);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MAX_TASKS = 40;

// The default routine: the daily and weekly limits that are lost, or stop
// filling, if left (from metabot.gg's and games.gg's AION 2 checklists and
// RaidRelay's gear score guide, 2026). Short on purpose; SUGGESTED_TASKS
// are offered under Edit tasks.
const DEFAULT_TASKS = [
  { id: "duties", name: "Duty Missions", every: "day", count: 5, tip: "Five completions a day, shared by the whole server (alts add none): 50k Kina and 1,000 Abyss Points each." },
  { id: "shugo", banks: true, name: "Shugo Festival", every: "day", count: 3, tip: "Three keys a day for the server, kept up to 12 (21 with membership): run them before they cap." },
  { id: "nightmare", banks: true, name: "Nightmare", every: "day", count: 2, tip: "Two tries a day, kept up to 14. Failing is free: use them on the lowest tier you haven't cleared." },
  { id: "invasion", banks: true, name: "Dimensional Invasion", every: "day", count: 1, tip: "One key a day for the server, kept up to 7." },
  { id: "odyle", name: "Spend Odyle Energy", every: "day", count: 1, tip: "+15 every 3 hours (120 a day) up to 560 (840 with membership); over the cap is lost. Cubes cost 40. Below gear score 1,400, keep it for Urugugu Canyon or Vakron." },
  { id: "dungeons", name: "Unknown Fissure (daily dungeon)", every: "week", count: 14, tip: "14 entries a week for the server, gone at the reset: about two a day." },
  { id: "ascension", name: "Ascension Trial", every: "week", count: 3, tip: "Three solo entries; they refill to three, not six." },
  { id: "expedition", name: "Expedition reward counts", every: "week", count: 7, tip: "Seven reward counts per Expedition dungeon, gone at the reset." },
  { id: "odyleCraft", name: "Odyle Energy crafts (Substance Morph)", every: "week", count: 4, tip: "Four a week per character, 16 per server: the server's 16 on your main." },
  { id: "conquest", name: "Conquest and Transcendence counts", every: "week", count: 1, tip: "Conquest +1 every 8 h (up to 21), Transcendence +1 every 12 h (up to 14): about a week each before they cap. Always claim the cube." },
  { id: "shops", name: "Weekly shop limits", every: "week", count: 1, tip: "Abyss, Shugo and Nightmare shops: buy the week's limits before Wednesday." },
];

// More to add under Edit tasks, for those who do them.
const SUGGESTED_TASKS = [
  { id: "rift", name: "Spacetime Rift", every: "day", count: 1, tip: "Opens several times a day (Event Timers has the times). Skipping rifts leaves you short on the way to 1,400." },
  { id: "raids", name: "Raid attempts", every: "week", count: 4, tip: "Four attempts per raid a week; the final boss pays once (Ludra) or twice." },
  { id: "subjugation", name: "Subjugation", every: "week", count: 3, tip: "Three tickets a week." },
  { id: "battlefield", name: "Battlefield wins", every: "week", count: 3, tip: "Three victory rewards a week per character; stats are equalised." },
  { id: "commands", name: "Command Missions", every: "week", count: 1, tip: "Buy up to 12 a week (server) from the Command Merchant; do them whenever." },
  { id: "abyssCommands", name: "Abyss Commands", every: "week", count: 1, tip: "Up to 20 scrolls a week (server) from the Abyss merchant: Abyss Points, Enhance Stones, Stigma materials." },
  { id: "abyssTime", name: "Abyss time", every: "week", count: 1, tip: "Seven hours per layer, back to seven on Wednesday." },
  { id: "pass", name: "Daeva Pass weekly EXP", every: "week", count: 1, tip: "The pass's weekly EXP limit (50,000 on Season 1): use it before the reset." },
];
const KNOWN_TASKS = [...DEFAULT_TASKS, ...SUGGESTED_TASKS];

// Tasks kept from before: a default one the player never changed takes the
// current wording and count; a default new since is added once; tasks the
// player edited or added stay as they are.
function refreshTasks() {
  const known = new Set(prefs.known || []);
  for (const t of prefs.tasks) {
    const d = KNOWN_TASKS.find((x) => x.id === t.id);
    if (d && !t.custom) Object.assign(t, { name: d.name, tip: d.tip, count: d.count, every: d.every, banks: !!d.banks });
  }
  const have = new Set(prefs.tasks.map((t) => t.id));
  for (const d of DEFAULT_TASKS) if (!known.has(d.id) && !have.has(d.id)) prefs.tasks.push({ ...d });
  prefs.known = DEFAULT_TASKS.map((d) => d.id);
  save();
}

let prefs = {
  tasks: DEFAULT_TASKS.map((t) => ({ ...t })),
  resetHour: 7, // UTC
  resetDay: 3, // Wednesday
  remindDay: 2, // hours before the daily reset, 0 for never
  remindWeek: 6,
  system: false,
};
let character = null;
let progress = {}; // task id → { n, period }
let editing = false;
let game = true;

const save = () => a2.storage.set("prefs", prefs).catch(() => {});
const charKey = () => (character?.name ? `progress:${character.name}@${character.serverId || 0}` : "progress:");
const saveProgress = () => a2.storage.set(charKey(), progress).catch(() => {});

// ── resets ──────────────────────────────────────────────────────────────────

// The last daily reset at or before `now`, and the next one.
function dailyPeriod(now = Date.now()) {
  const d = new Date(now);
  let start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), prefs.resetHour);
  if (start > now) start -= DAY;
  return { start, end: start + DAY };
}

function weeklyPeriod(now = Date.now()) {
  const { start: today } = dailyPeriod(now);
  const back = (new Date(today).getUTCDay() - prefs.resetDay + 7) % 7;
  const start = today - back * DAY;
  return { start, end: start + WEEK };
}

const periodOf = (task, now) => (task.every === "week" ? weeklyPeriod(now) : dailyPeriod(now));

// Done so far this period: a count from an earlier period is zero.
function doneOf(task, now = Date.now()) {
  const p = progress[task.id];
  return p && p.period === periodOf(task, now).start ? Math.min(task.count, p.n) : 0;
}

function setDone(task, n) {
  progress[task.id] = { n: Math.max(0, Math.min(task.count, n)), period: periodOf(task).start };
  saveProgress();
  render();
}

const fmtIn = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
};

// ── reminders ───────────────────────────────────────────────────────────────

// Once a period: what is left, a few hours before it resets.
let reminded = {};
function remind(now = Date.now()) {
  for (const [every, hours, label] of [["day", prefs.remindDay, "Daily"], ["week", prefs.remindWeek, "Weekly"]]) {
    if (!hours) continue;
    const period = every === "week" ? weeklyPeriod(now) : dailyPeriod(now);
    const left = period.end - now;
    if (left > hours * HOUR || reminded[every] === period.start) continue;
    // Counts the game keeps (Shugo keys, Nightmare tries) aren't lost at a
    // daily reset: no reminder for them.
    const open = prefs.tasks.filter((t) => t.every === every && doneOf(t, now) < t.count && !(every === "day" && t.banks));
    reminded[every] = period.start;
    a2.storage.set("reminded", reminded).catch(() => {});
    if (!open.length) continue;
    const list = open.slice(0, 4).map((t) => (t.count > 1 ? `${t.count - doneOf(t, now)} ${t.name}` : t.name)).join(", ");
    const text = `${label} reset in ${fmtIn(left)}: ${list}${open.length > 4 ? ` and ${open.length - 4} more` : ""} left`;
    a2.notify(text).catch(() => {});
    if (prefs.system && !game) a2.systemNotify?.("Daily Planner", text).catch(() => {});
  }
}

// ── the page ────────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function taskRow(task) {
  const done = doneOf(task);
  const li = el("li", `task${done >= task.count ? " done" : ""}`);
  if (editing) {
    const name = el("input", "tName");
    name.type = "text";
    name.maxLength = 48;
    name.value = task.name;
    name.addEventListener("change", () => {
      task.name = name.value.trim() || task.name;
      task.custom = true;
      save();
    });
    const count = el("input", "tCount");
    count.type = "number";
    count.min = "1";
    count.max = "99";
    count.value = String(task.count);
    count.title = "How many times";
    count.addEventListener("change", () => {
      task.count = Math.max(1, Math.min(99, Math.round(Number(count.value) || 1)));
      task.custom = true;
      save();
      render();
    });
    const every = el("select", "tEvery");
    every.append(new Option("every day", "day"), new Option("every week", "week"));
    every.value = task.every;
    every.addEventListener("change", () => {
      task.every = every.value;
      task.custom = true;
      save();
      render();
    });
    const del = el("button", "btn small danger", "Remove");
    del.type = "button";
    del.addEventListener("click", () => {
      prefs.tasks = prefs.tasks.filter((t) => t !== task);
      save();
      render();
    });
    li.append(name, count, el("span", "unit", "×"), every, del);
    return li;
  }
  // A box per time, or a counter past six.
  const marks = el("div", "marks");
  if (task.count <= 6) {
    for (let i = 0; i < task.count; i++) {
      const b = el("button", `mark${i < done ? " on" : ""}`);
      b.type = "button";
      b.title = i < done ? "Not done" : "Done";
      b.setAttribute("aria-label", `${task.name}: ${i + 1} of ${task.count}`);
      b.addEventListener("click", () => setDone(task, i < done ? i : i + 1));
      marks.append(b);
    }
  } else {
    const minus = el("button", "btn small", "−");
    minus.type = "button";
    minus.addEventListener("click", () => setDone(task, done - 1));
    const plus = el("button", "btn small", "+");
    plus.type = "button";
    plus.addEventListener("click", () => setDone(task, done + 1));
    const bar = el("div", "meter");
    bar.style.setProperty("--f", String(done / task.count));
    marks.append(minus, el("span", "num", `${done} / ${task.count}`), plus, bar);
  }
  const info = el("div", "info");
  info.append(el("div", "tTitle", task.name));
  if (task.tip) info.append(el("div", "tip", task.tip));
  li.append(info, marks);
  return li;
}

function render() {
  const now = Date.now();
  for (const group of document.querySelectorAll(".group")) {
    const every = group.dataset.every;
    const tasks = prefs.tasks.filter((t) => t.every === every);
    group.querySelector(".tasks").replaceChildren(...tasks.map(taskRow));
    const finished = tasks.filter((t) => doneOf(t, now) >= t.count).length;
    group.querySelector(".groupCount").textContent = tasks.length ? `${finished} of ${tasks.length}` : "";
    group.hidden = !tasks.length && !editing;
  }
  const total = prefs.tasks.reduce((n, t) => n + t.count, 0);
  const done = prefs.tasks.reduce((n, t) => n + doneOf(t, now), 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  $(".pct").textContent = `${pct}%`;
  $(".ring .fg").style.strokeDasharray = `${(pct / 100) * 97.4} 97.4`;
  $(".who").textContent = character?.name ? `For ${character.name}` : "Log in to keep it per character";
  $(".dailyIn").textContent = `in ${fmtIn(dailyPeriod(now).end - now)}`;
  $(".weeklyIn").textContent = `in ${fmtIn(weeklyPeriod(now).end - now)}`;
  $(".edit").textContent = editing ? "Done editing" : "Edit tasks";
  $(".addTask").hidden = !editing || prefs.tasks.length >= MAX_TASKS;
  $(".restore").hidden = !editing;
  renderSuggestions();
}

// Under Edit tasks: the suggested ones not on the list, to add.
function renderSuggestions() {
  const box = $(".suggest");
  const have = new Set(prefs.tasks.map((t) => t.id));
  const left = SUGGESTED_TASKS.filter((t) => !have.has(t.id));
  box.hidden = !editing || !left.length;
  box.querySelector("ul").replaceChildren(
    ...left.map((t) => {
      const li = el("li", "task");
      const info = el("div", "info");
      info.append(el("div", "tTitle", `${t.name}${t.count > 1 ? ` ×${t.count}` : ""} · every ${t.every}`), el("div", "tip", t.tip));
      const add = el("button", "btn small", "+ Add");
      add.type = "button";
      add.addEventListener("click", () => {
        prefs.tasks.push({ ...t });
        save();
        render();
      });
      li.append(info, add);
      return li;
    }),
  );
}

function renderSettings() {
  const hours = (sel, list, fmt) => {
    $(sel).replaceChildren(...list.map((v) => new Option(fmt(v), String(v))));
  };
  hours(".resetHour", [...Array(24).keys()], (h) => `${String(h).padStart(2, "0")}:00`);
  $(".resetDay").replaceChildren(...["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => new Option(d, String(i))));
  hours(".remindDay", [0, 1, 2, 3, 4, 6], (h) => (h ? `${h} h before` : "Never"));
  hours(".remindWeek", [0, 2, 6, 12, 24, 48], (h) => (h ? (h >= 24 ? `${h / 24} day${h > 24 ? "s" : ""} before` : `${h} h before`) : "Never"));
  $(".resetHour").value = String(prefs.resetHour);
  $(".resetDay").value = String(prefs.resetDay);
  $(".remindDay").value = String(prefs.remindDay);
  $(".remindWeek").value = String(prefs.remindWeek);
  $(".system").checked = !!prefs.system;
  const at = new Date(dailyPeriod().end);
  const day = new Date(weeklyPeriod().end).toLocaleDateString(undefined, { weekday: "long" });
  $(".local").textContent = `every day at ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}, the weekly one on ${day}`;
}

for (const [sel, key] of [[".resetHour", "resetHour"], [".resetDay", "resetDay"], [".remindDay", "remindDay"], [".remindWeek", "remindWeek"]]) {
  $(sel).addEventListener("change", () => {
    prefs[key] = Number($(sel).value);
    save();
    renderSettings();
    render();
  });
}
$(".system").addEventListener("change", () => {
  prefs.system = $(".system").checked;
  save();
});
$(".edit").addEventListener("click", () => {
  editing = !editing;
  render();
});
$(".addTask").addEventListener("click", () => {
  prefs.tasks.push({ id: `t${Date.now().toString(36)}`, name: "New task", every: "day", count: 1, tip: "", custom: true });
  save();
  render();
  document.querySelector(".group[data-every=day] .task:last-child .tName")?.select();
});
$(".restore").addEventListener("click", () => {
  const have = new Set(prefs.tasks.map((t) => t.id));
  for (const t of DEFAULT_TASKS) if (!have.has(t.id)) prefs.tasks.push({ ...t });
  save();
  render();
});

a2.on("character", async (c) => {
  if (c?.name === character?.name && c?.serverId === character?.serverId) return;
  character = c || null;
  progress = (await a2.storage.get(charKey()).catch(() => null)) || {};
  render();
});
a2.on("game", (g) => (game = !!g?.running));
a2.on("hosted", () => document.body.classList.add("hosted"));

(async () => {
  const stored = await a2.storage.get("prefs").catch(() => null);
  if (stored && Array.isArray(stored.tasks)) {
    prefs = { ...prefs, ...stored };
    refreshTasks();
  } else {
    prefs.known = DEFAULT_TASKS.map((d) => d.id);
  }
  reminded = (await a2.storage.get("reminded").catch(() => null)) || {};
  progress = (await a2.storage.get(charKey()).catch(() => null)) || {};
  renderSettings();
  render();
  a2.ready();
  // The times to the resets, and counts reset at one; not while a task is
  // being typed in.
  setInterval(() => {
    if (!editing) render();
    remind();
  }, 30_000);
  remind();
})();
