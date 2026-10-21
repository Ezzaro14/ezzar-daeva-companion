// Combat Alerts: a loss-of-control notice over your character, and an alert
// when enemies put the same debuff on several party members. Both read the
// combat feed (a2.on("combat")); this page decides and plays the sounds, the
// two widgets draw.
const $ = (s) => document.querySelector(s);

const KINDS = {
  stun: "Stunned",
  sleep: "Asleep",
  fear: "Feared",
  knockdown: "Knocked down",
  airborne: "Airborne",
  stumble: "Stumbled",
  bind: "Bound",
  root: "Rooted",
  freeze: "Frozen",
  petrify: "Petrified",
  charm: "Charmed",
  polymorph: "Transformed",
  silence: "Silenced",
};
const MAX_SEEN = 40;

const DEFAULTS = {
  locOn: true,
  kinds: Object.fromEntries(Object.keys(KINDS).map((k) => [k, k !== "silence"])),
  locSound: "thud",
  locSize: 1,
  debOn: true,
  debMin: 2,
  debMode: "all",
  debSound: "alarm",
  debHold: 6,
  volume: 0.8,
  watched: [],
};
let prefs = structuredClone(DEFAULTS);
let seen = {};
let snap = null;
let offset = 0;

const save = () => a2.storage.set("prefs", prefs).catch(() => {});
// "seen2": the list from before held buffs and rewards too (Abyss Tier
// Rewards, scrolls), from before debuffs were told apart by their icon.
const saveSeen = () => a2.storage.set("seen2", seen).catch(() => {});

// ── loss of control ─────────────────────────────────────────────────────────

let locShown = false;
let locKey = "";
function lossOfControl() {
  const now = Date.now();
  const holds = (snap?.abnormals || []).filter(
    (a) => a.own && a.control && prefs.kinds[a.control] && (!a.endMs || a.endMs + offset > now),
  );
  // The one that lasts longest is what holds you.
  const on = holds.sort((a, b) => (b.endMs || Infinity) - (a.endMs || Infinity))[0];
  if (!prefs.locOn || !on) {
    if (locShown) a2.widgets.send("loc", { active: false }).catch(() => {});
    locShown = false;
    locKey = "";
    return;
  }
  const key = `${on.abnormal}:${on.startMs}`;
  if (key !== locKey) {
    locKey = key;
    playSound(prefs.locSound, prefs.volume);
  }
  locShown = true;
  a2.widgets
    .send("loc", {
      active: true,
      label: KINDS[on.control] || on.control,
      name: on.name,
      icons: on.icons,
      endAt: on.endMs ? on.endMs + offset : null,
      lengthMs: on.endMs ? on.endMs - on.startMs : null,
      scale: prefs.locSize,
    })
    .catch(() => {});
}

// ── party debuffs ───────────────────────────────────────────────────────────

// Debuffs alerted on, by name, until fewer members have them again.
const alerted = new Set();
let alertUntil = 0;
function partyDebuffs() {
  if (!snap) return;
  const now = Date.now();
  const members = new Set([snap.me, ...(snap.party || []).map((p) => p.id)].filter((x) => x != null));
  const groups = new Map();
  for (const a of snap.abnormals || []) {
    // Only debuffs (the feed tells them by their icon): a reward, scroll or
    // buff the whole party has is no enemy's doing.
    if (a.byParty || a.debuff === false || a.caster === a.entity || !members.has(a.entity) || !a.name) continue;
    if (a.endMs && a.endMs + offset <= now) continue;
    const g = groups.get(a.name) || { name: a.name, icons: a.icons, abnormal: a.abnormal, on: new Set(), endMs: 0 };
    g.on.add(a.entity);
    g.endMs = Math.max(g.endMs, a.endMs || 0);
    groups.set(a.name, g);
  }
  let seenChanged = false;
  for (const g of groups.values()) {
    const s = seen[g.name] || { icons: g.icons, most: 0 };
    if (g.on.size > s.most || !seen[g.name]) {
      s.most = Math.max(s.most, g.on.size);
      seenChanged = true;
    }
    s.icons = g.icons;
    s.last = now;
    seen[g.name] = s;
  }
  if (seenChanged) {
    const names = Object.keys(seen).sort((a, b) => seen[b].last - seen[a].last);
    for (const n of names.slice(MAX_SEEN)) delete seen[n];
    saveSeen();
    renderLists();
  }
  if (!prefs.debOn) return;
  const watched = (name) => prefs.debMode === "all" || prefs.watched.includes(name);
  for (const name of [...alerted]) {
    const g = groups.get(name);
    if (!g || g.on.size < prefs.debMin) alerted.delete(name);
  }
  const fresh = [...groups.values()].filter((g) => g.on.size >= prefs.debMin && watched(g.name) && !alerted.has(g.name));
  if (fresh.length) {
    const g = fresh.sort((a, b) => b.on.size - a.on.size)[0];
    for (const f of fresh) alerted.add(f.name);
    alertUntil = now + prefs.debHold * 1000;
    playSound(prefs.debSound, prefs.volume);
    a2.widgets
      .send("debuff", { active: true, name: g.name, icons: g.icons, count: g.on.size, of: members.size, until: alertUntil, holdMs: prefs.debHold * 1000 })
      .catch(() => {});
  }
}
setInterval(() => {
  if (alertUntil && Date.now() > alertUntil) {
    alertUntil = 0;
    a2.widgets.send("debuff", { active: false }).catch(() => {});
  }
}, 250);

// ── the page ────────────────────────────────────────────────────────────────

function fillSounds(select) {
  select.replaceChildren(...Object.entries(SOUND_NAMES).map(([v, t]) => Object.assign(document.createElement("option"), { value: v, textContent: t })));
}

function button(text, onClick, title = "") {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "btn small";
  el.textContent = text;
  el.title = title;
  el.addEventListener("click", onClick);
  return el;
}

function renderLists() {
  $(".watched").replaceChildren(
    ...prefs.watched.map((name) => {
      const li = document.createElement("li");
      li.className = "item";
      const label = Object.assign(document.createElement("span"), { className: "grow", textContent: name });
      li.append(iconElement(seen[name]?.icons, name), label, button("×", () => {
        prefs.watched = prefs.watched.filter((n) => n !== name);
        save();
        renderLists();
      }, "Stop watching"));
      return li;
    }),
  );
  $(".watchedEmpty").hidden = prefs.watched.length > 0;
  const names = Object.keys(seen).sort((a, b) => seen[b].last - seen[a].last);
  $(".seen").replaceChildren(
    ...names.map((name) => {
      const li = document.createElement("li");
      li.className = "item";
      const label = Object.assign(document.createElement("span"), { className: "grow", textContent: name });
      const sub = Object.assign(document.createElement("span"), { className: "sub", textContent: `on up to ${seen[name].most} at once` });
      label.append(document.createElement("br"), sub);
      li.append(iconElement(seen[name].icons, name), label);
      li.append(
        prefs.watched.includes(name)
          ? Object.assign(document.createElement("span"), { className: "tag", textContent: "watched" })
          : button("Watch", () => {
              prefs.watched.push(name);
              save();
              renderLists();
            }),
      );
      return li;
    }),
  );
  $(".seenEmpty").hidden = names.length > 0;
}

function renderPrefs() {
  $(".locOn").checked = prefs.locOn;
  $(".locSound").value = prefs.locSound;
  $(".locSize").value = prefs.locSize;
  $(".debOn").checked = prefs.debOn;
  $(".debMin").value = prefs.debMin;
  $(".debMode").value = prefs.debMode;
  $(".debSound").value = prefs.debSound;
  $(".debHold").value = prefs.debHold;
  $(".volume").value = prefs.volume;
  $(".kinds").replaceChildren(
    ...Object.entries(KINDS).map(([k, label]) => {
      const l = document.createElement("label");
      l.className = "inline kind";
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!prefs.kinds[k] });
      box.addEventListener("change", () => {
        prefs.kinds[k] = box.checked;
        save();
      });
      l.append(box, label);
      return l;
    }),
  );
}

const bind = (sel, key, read, after = () => {}) =>
  $(sel).addEventListener("change", () => {
    prefs[key] = read($(sel));
    save();
    after();
  });
bind(".locOn", "locOn", (el) => el.checked);
bind(".locSound", "locSound", (el) => el.value, () => playSound(prefs.locSound, prefs.volume));
bind(".locSize", "locSize", (el) => Number(el.value) || 1, openWidgets);
bind(".debOn", "debOn", (el) => el.checked);
bind(".debMin", "debMin", (el) => Math.max(1, Math.min(6, Math.round(Number(el.value) || 2))), renderPrefs);
bind(".debMode", "debMode", (el) => el.value);
bind(".debSound", "debSound", (el) => el.value, () => playSound(prefs.debSound, prefs.volume));
bind(".debHold", "debHold", (el) => Math.max(1, Math.min(30, Number(el.value) || 6)));
bind(".volume", "volume", (el) => Number(el.value));
$(".lock").addEventListener("change", () => a2.widgets.lock($(".lock").checked).catch(() => {}));

// Both notices show for a few seconds, to see and place them.
$(".test").addEventListener("click", () => {
  const now = Date.now();
  playSound(prefs.locSound, prefs.volume);
  a2.widgets.send("loc", { active: true, test: true, label: "Stunned", name: "Test", icons: [], endAt: now + 4000, lengthMs: 4000, scale: prefs.locSize }).catch(() => {});
  setTimeout(() => {
    if (!locShown) a2.widgets.send("loc", { active: false }).catch(() => {});
  }, 4200);
  setTimeout(() => {
    playSound(prefs.debSound, prefs.volume);
    alertUntil = Date.now() + prefs.debHold * 1000;
    a2.widgets.send("debuff", { active: true, name: "Heal Block", icons: [], count: 3, of: 6, until: alertUntil, holdMs: prefs.debHold * 1000 }).catch(() => {});
  }, 1200);
});

// Both notices show as outlines for half a minute, unlocked, to drag into place.
let placing = 0;
$(".place").addEventListener("click", async () => {
  clearTimeout(placing);
  await a2.widgets.lock(false).catch(() => {});
  $(".lock").checked = false;
  for (const n of ["loc", "debuff"]) a2.widgets.send(n, { placing: true }).catch(() => {});
  placing = setTimeout(() => {
    for (const n of ["loc", "debuff"]) a2.widgets.send(n, { placing: false }).catch(() => {});
  }, 30000);
});

async function openWidgets() {
  const s = prefs.locSize;
  await a2.widgets.open("loc", { width: Math.round(330 * s), height: Math.round(84 * s), label: "Loss of control" }).catch(() => {});
  await a2.widgets.open("debuff", { width: Math.round(340 * s), height: Math.round(84 * s), label: "Party debuff" }).catch(() => {});
}

a2.on("combat", (s) => {
  snap = s;
  offset = Date.now() - s.nowMs;
  const status = $(".status");
  status.textContent = s.me == null ? "Waiting for your character…" : `Watching you${s.party?.length ? ` and ${s.party.length} party members` : ""}`;
  lossOfControl();
  partyDebuffs();
});
a2.on("hosted", () => document.body.classList.add("hosted"));
// Edit layout (the dashboard): both notices as outlines, to be placed.
a2.on("layout", (o) => {
  for (const n of ["loc", "debuff"]) a2.widgets.send(n, { placing: !!o?.editing }).catch(() => {});
});
a2.on("locked", (on) => {
  $(".lock").checked = !!on;
});
a2.on("widget-message", ({ data }) => {
  if (data?.open) a2.window?.show?.();
});

(async () => {
  fillSounds($(".locSound"));
  fillSounds($(".debSound"));
  const stored = await a2.storage.get("prefs").catch(() => null);
  if (stored && typeof stored === "object") prefs = { ...DEFAULTS, ...stored, kinds: { ...DEFAULTS.kinds, ...(stored.kinds || {}) } };
  seen = (await a2.storage.get("seen2").catch(() => null)) || {};
  $(".lock").checked = await a2.widgets.locked().catch(() => false);
  renderPrefs();
  renderLists();
  await openWidgets();
  a2.ready();
})();
