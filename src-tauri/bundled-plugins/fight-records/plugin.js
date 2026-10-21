// Fight Records: personal bests per boss and character, from the fights the
// meter saves (a2.on("fight")); and timed training runs, from your damage on
// dummies in the combat feed (snapshot.dummy, added up since the meter
// started: a run is the difference from when it began).
const $ = (s) => document.querySelector(s);

const DEFAULTS = { pbNotice: true, pbFirst: false, pbSound: "rise", pbMin: 20, length: 60, trainWidget: false };
// A fight saved again within this long is still going on.
const SETTLE_MS = 40_000;
const MAX_RUNS = 200;
const MAX_RECENT = 30;

let prefs = { ...DEFAULTS };
let bests = {}; // character → key → best
let runs = [];
let recent = [];
let character = null;
let snap = null;
let tab = "bests";
let selectedRun = null;
let groupFilter = "";

const save = () => a2.storage.set("prefs", prefs).catch(() => {});
const saveBests = () => a2.storage.set("bests", bests).catch(() => {});
const saveRuns = () => a2.storage.set("runs", runs).catch(() => {});
const saveRecent = () => a2.storage.set("recent", recent).catch(() => {});

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const day = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" });
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");

// ── personal bests ──────────────────────────────────────────────────────────

const pending = new Map(); // fight id → { fight, at }
a2.on("fight", (fight) => {
  if (!fight) return;
  // The latest save of each fight, newest first.
  const brief = { id: fight.id, boss: fight.boss, startMs: fight.startMs, durationMs: fight.durationMs, isTrain: fight.isTrain, me: fight.me ? { dps: fight.me.dps } : null, players: fight.players };
  recent = [brief, ...recent.filter((f) => f.id !== fight.id)].sort((a, b) => b.startMs - a.startMs).slice(0, MAX_RECENT);
  saveRecent();
  if (tab === "recent") renderRecent();
  if (!fight.me || fight.isTrain) return;
  pending.set(fight.id, { fight, at: Date.now() });
});

// One line for the game's chat: the fight, its time, each player's DPS.
function chatLine(f) {
  const players = [...(f.players || [])].sort((a, b) => b.dps - a.dps).map((p) => `${p.name} ${k(p.dps)}`).join(" · ");
  return `${f.boss} ${clock(f.durationMs)} — ${players}`;
}

function renderRecent() {
  $(".recentEmpty").hidden = recent.length > 0;
  $(".fightList").replaceChildren(
    ...recent.map((f) => {
      const li = document.createElement("li");
      li.className = "item";
      const info = Object.assign(document.createElement("span"), { className: "grow", textContent: f.boss + (f.isTrain ? " (training)" : "") });
      info.append(
        document.createElement("br"),
        Object.assign(document.createElement("span"), {
          className: "sub",
          textContent: `${day(f.startMs)} · ${clock(f.durationMs)} · ${(f.players || []).length} players${f.me ? ` · you ${k(f.me.dps)} DPS` : ""}`,
        }),
      );
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn small";
      copy.textContent = "Copy for chat";
      copy.title = chatLine(f);
      copy.addEventListener("click", async () => {
        try {
          await a2.copy(chatLine(f));
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Couldn't copy";
        }
        setTimeout(() => (copy.textContent = "Copy for chat"), 1500);
      });
      li.append(info, copy);
      return li;
    }),
  );
}
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of [...pending]) {
    if (now - p.at < SETTLE_MS) continue;
    pending.delete(id);
    consider(p.fight);
  }
}, 2000);

function consider(f) {
  if (f.durationMs < prefs.pbMin * 1000 || !f.me.dps) return;
  const who = f.me.name || character?.name || "?";
  const key = `${f.mobCode || f.boss}|${f.dungeonId || 0}`;
  const mine = (bests[who] ||= {});
  const before = mine[key];
  if (before && before.dps >= f.me.dps) return;
  mine[key] = {
    boss: f.boss,
    dungeonId: f.dungeonId,
    dps: f.me.dps,
    damage: f.me.damage,
    durationMs: f.durationMs,
    at: f.startMs,
    fightId: f.id,
    previous: before ? before.dps : null,
  };
  saveBests();
  renderBests();
  if (prefs.pbNotice && (before || prefs.pbFirst)) {
    playSound(prefs.pbSound);
    toast({
      title: before ? "New personal best!" : "First record",
      line: `${f.boss} — ${k(f.me.dps)} DPS${before ? ` (+${(((f.me.dps - before.dps) / before.dps) * 100).toFixed(1)}%)` : ""}`,
    });
  }
}

let toastOpen = false;
async function toast(d) {
  if (!toastOpen) {
    await a2.widgets.open("notice", { width: 400, height: 84, label: "Personal best" }).catch(() => {});
    toastOpen = true;
  }
  a2.widgets.send("notice", { ...d, until: Date.now() + 7000 }).catch(() => {});
}

// ── training runs ───────────────────────────────────────────────────────────

// idle → armed (waiting for the first hit) → running → idle.
let run = { state: "idle" };

const totalsOf = (dummy) => {
  const skills = {};
  for (const s of dummy?.skills || []) skills[`${s.skill}:${s.dot ? 1 : 0}`] = s;
  return { totals: { ...(dummy?.totals || {}) }, skills, lastMs: dummy?.lastMs || 0 };
};

function startRun() {
  if (!snap) return;
  run = { state: "armed", lengthMs: prefs.length * 1000, base: totalsOf(snap.dummy) };
  renderRun();
}

function stopRun() {
  if (run.state === "running") finishRun(Math.max(1, snap.nowMs - run.startMs));
  run = { state: "idle" };
  renderRun();
}

function tickRun() {
  const d = snap?.dummy;
  if (!d) return;
  if (run.state === "armed" && d.lastMs > run.base.lastMs) {
    // The clock starts with the first hit after Start.
    run.state = "running";
    run.startMs = d.lastMs;
  }
  if (run.state === "running" && run.lengthMs && snap.nowMs - run.startMs >= run.lengthMs) {
    finishRun(run.lengthMs);
    run = { state: "idle" };
  }
  renderRun();
}

function diff(base, now) {
  const t = now.totals;
  const b = base.totals;
  const sub = (f) => (t[f] || 0) - (b[f] || 0);
  const skills = [];
  for (const [key, s] of Object.entries(now.skills)) {
    const o = base.skills[key] || {};
    const damage = s.damage - (o.damage || 0);
    if (damage <= 0) continue;
    skills.push({
      skill: s.skill,
      dot: s.dot,
      name: s.name,
      icons: s.icons,
      damage,
      hits: s.hits - (o.hits || 0),
      crit: s.crit - (o.crit || 0),
      back: s.back - (o.back || 0),
      perfect: s.perfect - (o.perfect || 0),
      double: s.double - (o.double || 0),
    });
  }
  skills.sort((a, b) => b.damage - a.damage);
  return { damage: sub("damage"), hits: sub("hits"), crit: sub("crit"), back: sub("back"), perfect: sub("perfect"), double: sub("double"), skills };
}

function finishRun(durationMs) {
  const r = diff(run.base, totalsOf(snap.dummy));
  if (r.damage <= 0) return;
  const n = runs.length + 1;
  const entry = {
    id: `run${Date.now().toString(36)}`,
    name: `Run ${n}`,
    group: groupFilter || "",
    notes: "",
    character: character?.name || "",
    startMs: run.startMs,
    durationMs,
    dps: Math.round(r.damage / (durationMs / 1000)),
    ...r,
  };
  runs = [entry, ...runs].slice(0, MAX_RUNS);
  saveRuns();
  selectedRun = entry.id;
  playSound("chime");
  renderRuns();
}

let trainOpen = false;
async function placeTrainWidget() {
  if (prefs.trainWidget && !trainOpen) {
    await a2.widgets.open("train", { width: 260, height: 96, label: "Training" }).catch(() => {});
    trainOpen = true;
  } else if (!prefs.trainWidget && trainOpen) {
    await a2.widgets.close("train").catch(() => {});
    trainOpen = false;
  }
  sendTrain();
}

function sendTrain() {
  if (!trainOpen) return;
  let dps = null;
  let left = null;
  let elapsed = null;
  if (run.state === "running" && snap) {
    const r = diff(run.base, totalsOf(snap.dummy));
    elapsed = snap.nowMs - run.startMs;
    dps = Math.round(r.damage / Math.max(1, elapsed / 1000));
    left = run.lengthMs ? run.lengthMs - elapsed : null;
  }
  a2.widgets
    .send("train", { state: run.state, lengthMs: run.state === "idle" ? prefs.length * 1000 : run.lengthMs, dps, left, elapsed, at: Date.now() })
    .catch(() => {});
}

// ── the page ────────────────────────────────────────────────────────────────

function renderTabs() {
  for (const b of document.querySelectorAll(".chips button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll(".view")) v.hidden = !v.classList.contains(tab);
}

function renderBests() {
  const names = Object.keys(bests);
  const pick = $(".charPick");
  const current = pick.value || character?.name || names[0] || "";
  pick.replaceChildren(...names.map((n) => Object.assign(document.createElement("option"), { value: n, textContent: n })));
  if (names.includes(current)) pick.value = current;
  const mine = bests[pick.value] || {};
  const rows = Object.entries(mine).sort((a, b) => b[1].at - a[1].at);
  $(".bestsEmpty").hidden = rows.length > 0;
  $(".bestTable").hidden = !rows.length;
  $(".bestTable tbody").replaceChildren(
    ...rows.map(([key, b]) => {
      const tr = document.createElement("tr");
      const cell = (text, cls = "") => Object.assign(document.createElement("td"), { textContent: text, className: cls });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn small";
      del.textContent = "×";
      del.title = "Forget this best";
      del.addEventListener("click", () => {
        delete mine[key];
        saveBests();
        renderBests();
      });
      const dps = cell(k(b.dps), "r");
      if (b.previous) dps.title = `Was ${k(b.previous)}`;
      const td = document.createElement("td");
      td.append(del);
      tr.append(cell(b.boss), dps, cell(clock(b.durationMs), "r"), cell(day(b.at), "r"), td);
      return tr;
    }),
  );
}

function renderRun() {
  const el = $(".runState");
  el.classList.toggle("live", run.state !== "idle");
  if (run.state === "idle") el.textContent = "Ready";
  else if (run.state === "armed") el.textContent = "Hit a dummy to start…";
  else {
    const elapsed = (snap?.nowMs || 0) - run.startMs;
    const r = diff(run.base, totalsOf(snap?.dummy));
    el.textContent = `${clock(run.lengthMs ? run.lengthMs - elapsed : elapsed)} · ${k(r.damage / Math.max(1, elapsed / 1000))} DPS`;
  }
  $(".start").disabled = run.state !== "idle";
  $(".stop").disabled = run.state === "idle";
  $(".length").disabled = run.state !== "idle";
  sendTrain();
}

function groups() {
  return [...new Set(runs.map((r) => r.group).filter(Boolean))].sort();
}

function renderRuns() {
  const gs = groups();
  $(".groupPick").replaceChildren(
    Object.assign(document.createElement("option"), { value: "", textContent: "All runs" }),
    ...gs.map((g) => Object.assign(document.createElement("option"), { value: g, textContent: g })),
  );
  $(".groupPick").value = gs.includes(groupFilter) ? groupFilter : "";
  $("#groups").replaceChildren(...gs.map((g) => Object.assign(document.createElement("option"), { value: g })));
  const list = runs.filter((r) => !groupFilter || r.group === groupFilter);
  $(".runsEmpty").hidden = list.length > 0;
  $(".runList").replaceChildren(
    ...list.map((r) => {
      const li = document.createElement("li");
      li.className = `item${r.id === selectedRun ? " sel" : ""}`;
      const info = Object.assign(document.createElement("span"), { className: "grow", textContent: r.name });
      info.append(
        document.createElement("br"),
        Object.assign(document.createElement("span"), {
          className: "sub",
          textContent: `${day(r.startMs)} · ${clock(r.durationMs)} · ${r.character || "?"}${r.group ? ` · ${r.group}` : ""}`,
        }),
      );
      li.append(info, Object.assign(document.createElement("span"), { className: "num", textContent: `${k(r.dps)} DPS` }));
      li.addEventListener("click", () => {
        selectedRun = selectedRun === r.id ? null : r.id;
        renderRuns();
      });
      return li;
    }),
  );
  const sel = runs.find((r) => r.id === selectedRun);
  $(".runDetail").hidden = !sel;
  if (sel) {
    $(".runName").value = sel.name;
    $(".runGroup").value = sel.group || "";
    $(".runNotes").value = sel.notes || "";
  }
}

function renderCompare() {
  const opts = runs.map((r) => Object.assign(document.createElement("option"), { value: r.id, textContent: `${r.name} — ${k(r.dps)} DPS` }));
  const a = $(".cmpA");
  const b = $(".cmpB");
  const va = a.value;
  const vb = b.value;
  a.replaceChildren(...opts.map((o) => o.cloneNode(true)));
  b.replaceChildren(...opts.map((o) => o.cloneNode(true)));
  a.value = runs.some((r) => r.id === va) ? va : runs[1]?.id || runs[0]?.id || "";
  b.value = runs.some((r) => r.id === vb) ? vb : runs[0]?.id || "";
  const A = runs.find((r) => r.id === a.value);
  const B = runs.find((r) => r.id === b.value);
  $(".cmpEmpty").hidden = runs.length >= 2;
  const table = $(".cmpTable");
  table.hidden = !(A && B);
  if (!A || !B) return;
  const tr = (cells, cls = "") => {
    const row = document.createElement("tr");
    row.className = cls;
    for (const c of cells) row.append(c instanceof Node ? c : Object.assign(document.createElement("td"), { textContent: c.text ?? c, className: c.cls || "" }));
    return row;
  };
  const vs = (x, y, f = k) => {
    const d = x && y ? ((y - x) / x) * 100 : null;
    return { text: d === null ? "" : `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`, cls: `r ${d > 0.05 ? "better" : d < -0.05 ? "worse" : ""}` };
  };
  const head = document.createElement("thead");
  head.append(tr([{ text: "" }, { text: A.name, cls: "r" }, { text: B.name, cls: "r" }, { text: "", cls: "r" }]));
  const body = document.createElement("tbody");
  const rate = (r, f) => (r.hits ? (r[f] / r.hits) * 100 : 0);
  for (const [label, fa, fb, fmt] of [
    ["DPS", A.dps, B.dps, k],
    ["Damage", A.damage, B.damage, k],
    ["Time", A.durationMs, B.durationMs, clock],
    ["Hits", A.hits, B.hits, String],
    ["Critical", rate(A, "crit"), rate(B, "crit"), (v) => `${v.toFixed(1)}%`],
    ["Back attack", rate(A, "back"), rate(B, "back"), (v) => `${v.toFixed(1)}%`],
    ["Perfect", rate(A, "perfect"), rate(B, "perfect"), (v) => `${v.toFixed(1)}%`],
    ["Double", rate(A, "double"), rate(B, "double"), (v) => `${v.toFixed(1)}%`],
  ]) {
    body.append(tr([label, { text: fmt(fa), cls: "r" }, { text: fmt(fb), cls: "r" }, vs(fa, fb)]));
  }
  body.append(tr([{ text: "Skills (DPS · share)" }, "", "", ""], "section"));
  const keyOf = (s) => `${s.skill}:${s.dot ? 1 : 0}`;
  const all = new Map();
  for (const s of [...A.skills, ...B.skills]) if (!all.has(keyOf(s))) all.set(keyOf(s), s);
  const dpsOf = (r, key) => {
    const s = r.skills.find((x) => keyOf(x) === key);
    return s ? s.damage / (r.durationMs / 1000) : 0;
  };
  const share = (r, key) => pct(r.skills.find((x) => keyOf(x) === key)?.damage || 0, r.damage);
  for (const [key, s] of [...all].sort((x, y) => dpsOf(B, y[0]) + dpsOf(A, y[0]) - dpsOf(B, x[0]) - dpsOf(A, x[0]))) {
    const name = document.createElement("td");
    name.className = "skill";
    name.append(iconElement(s.icons, s.name), `${s.name || `#${s.skill}`}${s.dot ? " (ticks)" : ""}`);
    const a1 = dpsOf(A, key);
    const b1 = dpsOf(B, key);
    body.append(tr([name, { text: `${k(a1)} · ${share(A, key)}`, cls: "r" }, { text: `${k(b1)} · ${share(B, key)}`, cls: "r" }, vs(a1, b1)]));
  }
  table.replaceChildren(head, body);
}

// ── events ──────────────────────────────────────────────────────────────────

a2.on("combat", (s) => {
  snap = s;
  if (run.state !== "idle") tickRun();
});
a2.on("character", (c) => {
  character = c;
  $(".status").textContent = c?.name ? `Playing ${c.name}` : "Waiting for your character…";
  if (tab === "bests") renderBests();
});
a2.on("locked", (on) => {
  $(".lock").checked = !!on;
});
a2.on("widget-message", ({ name, data }) => {
  if (data?.open) a2.window?.show?.();
  if (name === "train" && data?.start && run.state === "idle") startRun();
  if (name === "train" && data?.stop) stopRun();
  if (name === "train" && data?.length) {
    prefs.length = Number(data.length);
    $(".length").value = String(prefs.length);
    save();
    sendTrain();
  }
});
a2.on("compact", (on) => document.body.classList.toggle("compact", !!on));
a2.on("hosted", () => document.body.classList.add("hosted"));

for (const b of document.querySelectorAll(".chips button")) {
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    renderTabs();
    if (tab === "bests") renderBests();
    if (tab === "recent") renderRecent();
    if (tab === "training") renderRuns();
    if (tab === "compare") renderCompare();
  });
}
$(".charPick").addEventListener("change", renderBests);
$(".start").addEventListener("click", startRun);
$(".stop").addEventListener("click", stopRun);
$(".length").addEventListener("change", () => {
  prefs.length = Number($(".length").value);
  save();
  sendTrain();
});
$(".groupPick").addEventListener("change", () => {
  groupFilter = $(".groupPick").value;
  renderRuns();
});
const runField = (sel, key) =>
  $(sel).addEventListener("change", () => {
    const r = runs.find((x) => x.id === selectedRun);
    if (!r) return;
    r[key] = $(sel).value.trim();
    saveRuns();
    renderRuns();
  });
runField(".runName", "name");
runField(".runGroup", "group");
runField(".runNotes", "notes");
$(".deleteRun").addEventListener("click", () => {
  runs = runs.filter((r) => r.id !== selectedRun);
  selectedRun = null;
  saveRuns();
  renderRuns();
});
$(".compareThis").addEventListener("click", () => {
  tab = "compare";
  renderTabs();
  renderCompare();
  $(".cmpB").value = selectedRun;
  renderCompare();
});
$(".cmpA").addEventListener("change", renderCompare);
$(".cmpB").addEventListener("change", renderCompare);
$(".lock").addEventListener("change", () => a2.widgets.lock($(".lock").checked).catch(() => {}));
const bind = (sel, key, read, after = () => {}) =>
  $(sel).addEventListener("change", () => {
    prefs[key] = read($(sel));
    save();
    after();
  });
bind(".pbNotice", "pbNotice", (el) => el.checked);
bind(".pbFirst", "pbFirst", (el) => el.checked);
bind(".pbSound", "pbSound", (el) => el.value, () => playSound(prefs.pbSound));
bind(".pbMin", "pbMin", (el) => Math.max(0, Number(el.value) || 0));
bind(".trainWidget", "trainWidget", (el) => el.checked, placeTrainWidget);

(async () => {
  $(".pbSound").replaceChildren(...Object.entries(SOUND_NAMES).map(([v, t]) => Object.assign(document.createElement("option"), { value: v, textContent: t })));
  const stored = await a2.storage.get("prefs").catch(() => null);
  if (stored && typeof stored === "object") prefs = { ...DEFAULTS, ...stored };
  bests = (await a2.storage.get("bests").catch(() => null)) || {};
  runs = (await a2.storage.get("runs").catch(() => null)) || [];
  recent = (await a2.storage.get("recent").catch(() => null)) || [];
  $(".pbNotice").checked = prefs.pbNotice;
  $(".pbFirst").checked = prefs.pbFirst;
  $(".pbSound").value = prefs.pbSound;
  $(".pbMin").value = prefs.pbMin;
  $(".length").value = String(prefs.length);
  $(".trainWidget").checked = prefs.trainWidget;
  $(".lock").checked = await a2.widgets.locked().catch(() => false);
  renderTabs();
  renderBests();
  renderRun();
  await placeTrainWidget();
  a2.ready();
})();
