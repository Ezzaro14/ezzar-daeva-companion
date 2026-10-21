// Combat Assist: bars of skills and buffs over the game. This page keeps the
// bars and the cooldowns, works out each icon's state from the combat feed
// (a2.on("combat")) and hands it to the bar widgets, which draw it.
const $ = (s) => document.querySelector(s);

const MAX_BARS = 8;
const MAX_ITEMS = 16;
// Gaps kept per skill, the shortest; the cooldown is read from them.
const MAX_GAPS = 8;
// A cast this much sooner than the cooldown was shortened by something else.
const SHORTENED = 0.85;

const newBar = (n) => ({
  id: `bar${Date.now().toString(36)}${n}`,
  name: `Bar ${n}`,
  show: true,
  hideOoc: false,
  onlyCooling: false,
  glow: true,
  text: true,
  shape: "square",
  dir: "row",
  size: 44,
  items: [],
});

let prefs = { bars: [newBar(1)], selected: 0, overrides: {}, gaps: {} };
let snap = null;
// Local clock minus the meter's, so times from the feed draw on this clock.
let offset = 0;
let lastCasts = new Map();

const bar = () => prefs.bars[Math.min(prefs.selected, prefs.bars.length - 1)];
const save = () => a2.storage.set("prefs", prefs).catch(() => {});

// ── cooldowns ───────────────────────────────────────────────────────────────

// Two gaps this close (8%) are the same cooldown seen twice.
const SAME_GAP = 1.08;
// A short gap this many times under the long ones, again and again, is an
// effect that lands after the cast (a delayed explosion), not a cast.
const FOLLOW_UP = 2.2;
// Gaps kept per skill in the order seen, for the patterns above.
const MAX_SEQ = 24;

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

// The cooldown of a skill, in ms, and how sure it is: the player's own; else
// learnt from the gaps between casts.
// - A skill whose effect lands seconds after the cast reads as two casts:
//   short and long gaps take turns (3 s, 17 s, 3 s, 17 s), and the cooldown
//   is the two together (20 s).
// - Else the shortest gap (a lone much shorter one is a cast another skill
//   sped up): sure once another gap comes close to it, else a first guess.
function cooldownOf(skill) {
  const set = Number(prefs.overrides[skill]);
  if (Number.isFinite(set) && set > 0) return { ms: set * 1000, learnt: false, sure: true };
  const seq = prefs.seq?.[skill] || [];
  const gaps = (seq.length ? seq : prefs.gaps[skill] || []).slice().sort((a, b) => a - b);
  if (!gaps.length) return { ms: null, learnt: true, sure: false };
  if (seq.length >= 3) {
    let split = -1;
    let jump = 0;
    for (let i = 1; i < gaps.length; i++) {
      const r = gaps[i] / gaps[i - 1];
      if (r > jump) [jump, split] = [r, i];
    }
    if (jump >= FOLLOW_UP) {
      const cut = gaps[split];
      const isShort = (g) => g < cut;
      let pairs = 0;
      for (let i = 0; i + 1 < seq.length; i++) if (isShort(seq[i]) && !isShort(seq[i + 1])) pairs++;
      const shorts = seq.filter(isShort).length;
      if (pairs >= 2 && pairs >= shorts * 0.6) {
        return { ms: gaps[split] + median(gaps.slice(0, split)), learnt: true, sure: true, followUp: true };
      }
    }
  }
  // The shortest gap is the most the cooldown can be: no skill is cast
  // before it's ready. A lone one well under the rest is a cast another
  // skill sped up (a reset): the next one then. Sure once a second gap
  // comes within 8% of it; until then a first guess.
  let ms = gaps[0];
  if (gaps.length >= 3 && gaps[0] < gaps[1] * SHORTENED) ms = gaps[1];
  const near = gaps.filter((g) => g >= ms && g <= ms * SAME_GAP).length;
  return { ms, learnt: true, sure: near >= 2 };
}

// A new cast with a gap since the one before: keep the gap.
function learn(casts) {
  let changed = false;
  for (const c of casts) {
    const before = lastCasts.get(c.skill);
    lastCasts.set(c.skill, c.lastCastMs);
    if (before === undefined || before === c.lastCastMs || !c.lastGapMs) continue;
    const gaps = prefs.gaps[c.skill] || [];
    gaps.push(c.lastGapMs);
    gaps.sort((a, b) => a - b);
    prefs.gaps[c.skill] = gaps.slice(0, MAX_GAPS);
    const seq = ((prefs.seq ||= {})[c.skill] ||= []);
    seq.push(c.lastGapMs);
    if (seq.length > MAX_SEQ) seq.splice(0, seq.length - MAX_SEQ);
    changed = true;
  }
  // The feed's shortest gap covers casts from before this window opened.
  for (const c of casts) {
    if (c.minGapMs && !(prefs.gaps[c.skill] || []).length) {
      prefs.gaps[c.skill] = [c.minGapMs];
      changed = true;
    }
  }
  if (changed) save();
}

// ── what each widget shows ──────────────────────────────────────────────────

function itemState(item) {
  const base = { key: `${item.kind}:${item.id}`, kind: item.kind, name: item.name, icons: item.icons };
  if (item.kind === "skill") {
    const cast = snap?.casts?.find((c) => c.skill === item.id);
    const cd = cooldownOf(item.id);
    const last = cast ? cast.lastCastMs + offset : null;
    return {
      ...base,
      icons: cast?.icons?.length ? cast.icons : item.icons,
      cdMs: cd.ms,
      unknown: cd.ms === null,
      readyAt: last !== null && cd.ms ? last + cd.ms : null,
      shortened: !!(cast?.lastGapMs && cd.ms && cast.lastGapMs < cd.ms * SHORTENED),
    };
  }
  const own = (snap?.abnormals || []).filter((a) => a.own && (a.abnormal === item.id || (item.name && a.name === item.name)));
  const on = own.sort((a, b) => (b.endMs || 0) - (a.endMs || 0))[0];
  return {
    ...base,
    icons: on?.icons?.length ? on.icons : item.icons,
    active: !!on,
    endless: !!on?.endless,
    endAt: on?.endMs ? on.endMs + offset : null,
    lengthMs: on?.endMs ? on.endMs - on.startMs : null,
    stacks: on?.stacks || 0,
  };
}

// The widget's frame: the bar as widget.css lays it out, with room around it
// for the ready glow.
const widgetSize = (b) => {
  const n = Math.max(1, b.items.length);
  const s = b.size;
  const room = 10;
  if (b.shape === "bar") {
    const w = s * 4.4;
    const h = s * 0.62;
    const gap = 3;
    const pad = 6;
    return b.dir === "row"
      ? { width: Math.round(n * w + (n - 1) * gap + pad * 2 + room * 2), height: Math.round(h + pad * 2 + room * 2) }
      : { width: Math.round(w + pad * 2 + room * 2), height: Math.round(n * h + (n - 1) * gap + pad * 2 + room * 2) };
  }
  const gap = s * 0.12;
  const pad = 4;
  return b.dir === "row"
    ? { width: Math.round(n * s + (n - 1) * gap + pad * 2 + room * 2), height: Math.round(s + pad * 2 + room * 2) }
    : { width: Math.round(s + pad * 2 + room * 2), height: Math.round(n * s + (n - 1) * gap + pad * 2 + room * 2) };
};

const opened = new Map(); // widget name → size it was opened at
async function placeWidgets() {
  const wanted = new Set();
  for (const b of prefs.bars) {
    if (!b.show || !b.items.length) continue;
    wanted.add(b.id);
    const size = widgetSize(b);
    const key = `${size.width}x${size.height}:${b.name}`;
    if (opened.get(b.id) !== key) {
      await a2.widgets.open(b.id, { ...size, label: b.name }).catch(() => {});
      opened.set(b.id, key);
    }
  }
  for (const name of [...opened.keys()]) {
    if (!wanted.has(name)) {
      await a2.widgets.close(name).catch(() => {});
      opened.delete(name);
    }
  }
  sendAll();
}

function sendAll() {
  for (const b of prefs.bars) {
    if (!opened.has(b.id)) continue;
    a2.widgets
      .send(b.id, {
        shape: b.shape,
        dir: b.dir,
        size: b.size,
        glow: b.glow,
        text: b.text,
        hidden: b.hideOoc && !snap?.inCombat && !editing,
        // Only what is cooling down (or a buff that is on); all while the
        // layout is edited, to be placed.
        onlyCooling: !!b.onlyCooling && !editing,
        items: b.items.map(itemState),
      })
      .catch(() => {});
  }
}

// ── the page ────────────────────────────────────────────────────────────────

const fmtS = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);
let pickTab = "skills";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(text, onClick, title = "", cls = "btn small") {
  const b = el("button", cls, text);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function render() {
  renderBarTabs();
  renderPreview();
  renderItems();
  renderLook();
  renderPicks();
  renderSteps();
}

function renderBarTabs() {
  const tabs = $(".barTabs");
  tabs.replaceChildren(
    ...prefs.bars.map((b, i) => {
      const t = button(b.name, () => {
        prefs.selected = i;
        save();
        render();
      }, `${b.items.length} on it${b.show ? "" : ", hidden"}`, "barTab");
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", String(i === prefs.selected));
      t.append(el("span", "count", String(b.items.length)));
      if (!b.show) t.classList.add("off");
      return t;
    }),
  );
  if (prefs.bars.length < MAX_BARS) {
    tabs.append(button("+ New bar", () => {
      prefs.bars.push(newBar(prefs.bars.length + 1));
      prefs.selected = prefs.bars.length - 1;
      save();
      render();
    }, "Another bar, placed on its own", "barTab add"));
  }
}

// The bar as it shows over the game, drawn here from what is on it.
function renderPreview() {
  const b = bar();
  const stage = $(".previewStage");
  stage.style.setProperty("--size", `${Math.min(b.size, 52)}px`);
  stage.className = `previewStage shape-${b.shape} ${b.dir}`;
  if (!b.items.length) {
    stage.replaceChildren(el("span", "previewEmpty", "Nothing on this bar yet"));
  } else {
    stage.replaceChildren(
      ...b.items.map((item) => {
        const slot = el("div", `pv ${item.kind}`);
        slot.append(iconElement(item.icons, item.name));
        if (b.shape === "bar") slot.append(el("span", "pvName", item.name || ""));
        let label = "";
        if (item.kind === "skill") {
          const cd = cooldownOf(item.id);
          label = cd.ms ? `${Math.round(cd.ms / 1000)}` : "?";
          if (!cd.ms) slot.classList.add("unknown");
        }
        if (b.text || item.kind === "skill") slot.append(el("span", "pvTime", label));
        return slot;
      }),
    );
  }
  const skills = b.items.filter((i) => i.kind === "skill").length;
  const buffs = b.items.length - skills;
  const parts = [skills && `${skills} skill${skills > 1 ? "s" : ""}`, buffs && `${buffs} buff${buffs > 1 ? "s" : ""}`].filter(Boolean);
  $(".previewMeta").textContent = `${parts.join(" · ") || "empty"}${b.show ? "" : " · hidden"}${b.hideOoc ? " · only in combat" : ""}${b.onlyCooling ? " · only while on cooldown" : ""}`;
}

function cooldownText(item) {
  const set = Number(prefs.overrides[item.id]);
  if (Number.isFinite(set) && set > 0) return { text: `${set} s, set by you`, cls: "set" };
  const cd = cooldownOf(item.id);
  if (cd.ms && cd.sure) return { text: `${fmtS(cd.ms)}, learned from use${cd.followUp ? " (with its delayed hit)" : ""}`, cls: "learnt" };
  if (cd.ms) return { text: `~${fmtS(cd.ms)} at most, not confirmed: cast it the moment it's ready, or type the game's cooldown`, cls: "unsure" };
  return { text: "Not known yet: use it twice, right when it's ready", cls: "unknown" };
}

function renderItems() {
  const b = bar();
  const list = $(".items");
  list.replaceChildren(
    ...b.items.map((item, i) => {
      const li = el("li", "item");
      li.append(iconElement(item.icons, item.name));
      const info = el("span", "grow");
      info.append(el("span", "itemName", item.name || `#${item.id}`));
      if (item.kind === "skill") {
        const cd = cooldownText(item);
        info.append(el("span", `sub cdState ${cd.cls}`, cd.text));
      } else {
        info.append(el("span", "sub", "Buff: lights up while it's on you, with the time left"));
      }
      li.append(info);
      if (item.kind === "skill") {
        const input = el("input", "cd");
        input.type = "number";
        input.min = "0";
        input.step = "0.5";
        input.title = "Cooldown in seconds. Leave empty to learn it from use.";
        input.placeholder = "auto";
        input.value = prefs.overrides[item.id] ?? "";
        input.setAttribute("aria-label", `Cooldown of ${item.name} in seconds`);
        input.addEventListener("change", () => {
          const v = Number(input.value);
          if (input.value === "" || !Number.isFinite(v) || v <= 0) delete prefs.overrides[item.id];
          else prefs.overrides[item.id] = v;
          save();
          render();
          sendAll();
        });
        li.append(input, el("span", "unit", "s"));
        // A learnt cooldown that came out wrong: forget it and learn again.
        if (!prefs.overrides[item.id] && (prefs.gaps[item.id] || []).length) {
          li.append(button("Re-learn", () => {
            delete prefs.gaps[item.id];
            if (prefs.seq) delete prefs.seq[item.id];
            save();
            render();
            sendAll();
          }, "Forget the learnt cooldown and learn it again from your next casts"));
        }
      }
      const move = (d) => () => {
        const j = i + d;
        if (j < 0 || j >= b.items.length) return;
        [b.items[i], b.items[j]] = [b.items[j], b.items[i]];
        save();
        render();
        sendAll();
      };
      const up = button("↑", move(-1), "Move earlier");
      const down = button("↓", move(1), "Move later");
      up.disabled = i === 0;
      down.disabled = i === b.items.length - 1;
      li.append(up, down, button("Remove", () => {
        b.items.splice(i, 1);
        save();
        render();
        placeWidgets();
      }, "Take it off this bar", "btn small danger"));
      return li;
    }),
  );
  $(".itemsEmpty").hidden = b.items.length > 0;
}

function renderLook() {
  const b = bar();
  $(".barName").value = b.name;
  $(".barShow").checked = b.show;
  $(".barOoc").checked = b.hideOoc;
  $(".barCooling").checked = !!b.onlyCooling;
  $(".barGlow").checked = b.glow;
  $(".barText").checked = b.text;
  for (const [sel, value] of [[".barShape", b.shape], [".barDir", b.dir]]) {
    for (const btn of document.querySelectorAll(`${sel} button`)) btn.setAttribute("aria-pressed", String(btn.dataset.v === value));
  }
  $(".barSize").value = b.size;
  $(".sizeVal").textContent = `${b.size} px`;
  $(".removeBar").disabled = prefs.bars.length <= 1;
  $(".pickBar").textContent = b.name;
}

function addItem(item) {
  const b = bar();
  if (b.items.some((x) => x.kind === item.kind && x.id === item.id)) return false;
  if (b.items.length >= MAX_ITEMS) return false;
  b.items.push(item);
  return true;
}

function added() {
  save();
  render();
  placeWidgets();
}

const usedSkills = () => (snap?.casts || []).filter((c) => c.name).sort((a, b) => b.uses - a.uses || b.lastCastMs - a.lastCastMs);

function renderPicks() {
  const b = bar();
  const on = (kind, id) => b.items.some((x) => x.kind === kind && x.id === id);
  const now = snap?.nowMs || 0;
  const q = $(".pickSearch").value.trim().toLowerCase();
  const match = (name) => !q || String(name).toLowerCase().includes(q);
  for (const t of document.querySelectorAll(".pickTabs button")) t.setAttribute("aria-selected", String(t.dataset.tab === pickTab));
  for (const v of document.querySelectorAll(".colPick .view")) v.hidden = !v.classList.contains(pickTab);
  const row = (icons, name, sub, isOn, add) => {
    const li = el("li", `item pick${isOn ? " isOn" : ""}`);
    const info = el("span", "grow");
    info.append(el("span", "itemName", name), el("span", "sub", sub));
    li.append(iconElement(icons, name), info);
    li.append(isOn ? el("span", "tag onBar", "✓ On bar") : button("Add", add, `Add to ${b.name}`, "btn small primary"));
    return li;
  };
  const skills = usedSkills().filter((c) => match(c.name));
  $(".skillList").replaceChildren(
    ...(skills.length
      ? skills.map((c) => {
          const cd = cooldownOf(c.skill);
          const sub = `used ${c.uses}× · ${cd.ms ? `cooldown ${fmtS(cd.ms)}` : "cooldown not known yet"} · ${fmtS(Math.max(0, now - c.lastCastMs))} ago`;
          return row(c.icons, c.name, sub, on("skill", c.skill), () => addItem({ kind: "skill", id: c.skill, name: c.name, icons: c.icons }) && added());
        })
      : [el("li", "empty", snap?.me == null ? "Log in to a character, then use a skill." : q ? "No skill by that name." : "No skills used yet. Cast something in game.")]),
  );
  const seen = new Set();
  const buffs = (snap?.abnormals || []).filter((a) => a.own && a.name && !seen.has(a.abnormal) && seen.add(a.abnormal) && match(a.name));
  $(".buffList").replaceChildren(
    ...(buffs.length
      ? buffs.map((a) => {
          const left = a.endMs ? fmtS(Math.max(0, a.endMs - now)) : "no timer";
          const from = a.byMe ? "yours" : a.byParty ? "from your party" : a.debuff ? "debuff" : "buff";
          const sub = `${from} · ${left}${a.stacks > 1 ? ` · ${a.stacks} stacks` : ""}`;
          return row(a.icons, a.name, sub, on("buff", a.abnormal), () => addItem({ kind: "buff", id: a.abnormal, name: a.name, icons: a.icons }) && added());
        })
      : [el("li", "empty", q ? "Nothing by that name on you." : "Nothing on you right now.")]),
  );
}

// The three steps, each ticked once done.
function renderSteps() {
  const done = {
    use: (snap?.casts || []).length > 0 || Object.keys(prefs.gaps).length > 0,
    add: prefs.bars.some((b) => b.items.length > 0),
    place: !!prefs.placed,
  };
  for (const li of document.querySelectorAll(".steps li")) li.classList.toggle("done", !!done[li.dataset.step]);
  $(".quickFill").disabled = !usedSkills().length;
  $(".steps").hidden = !!prefs.stepsHidden;
  $(".showSteps").hidden = !prefs.stepsHidden;
}

function renderStatus() {
  const s = $(".status");
  if (!snap) s.textContent = "Waiting for the game…";
  else if (snap.me == null) s.textContent = "Waiting for your character…";
  else s.textContent = snap.inCombat ? "In combat" : "Out of combat";
  s.classList.toggle("hot", !!snap?.inCombat);
}

// ── events ──────────────────────────────────────────────────────────────────

let pickRender = 0;
a2.on("combat", (s) => {
  snap = s;
  offset = Date.now() - s.nowMs;
  learn(s.casts || []);
  sendAll();
  renderStatus();
  // The pick lists change every tick; redraw them at most once a second.
  if (Date.now() - pickRender > 1000) {
    pickRender = Date.now();
    renderPicks();
    renderSteps();
  }
});
a2.on("compact", (on) => document.body.classList.toggle("compact", !!on));
a2.on("hosted", () => document.body.classList.add("hosted"));
// Edit layout (the dashboard): bars that hide out of combat show, to be placed.
let editing = false;
a2.on("layout", (o) => {
  editing = !!o?.editing;
  sendAll();
});
a2.on("locked", (on) => {
  $(".lock").checked = !!on;
});
a2.on("widget-message", ({ data }) => {
  if (data?.open) a2.window?.show?.();
});
// Moved on screen: step three is done.
a2.on("widget-moved", () => {
  if (prefs.placed) return;
  prefs.placed = true;
  save();
  renderSteps();
});

for (const t of document.querySelectorAll(".pickTabs button")) {
  t.addEventListener("click", () => {
    pickTab = t.dataset.tab;
    renderPicks();
  });
}
$(".pickSearch").addEventListener("input", () => renderPicks());
$(".lock").addEventListener("change", () => a2.widgets.lock($(".lock").checked).catch(() => {}));
$(".quickFill").addEventListener("click", () => {
  let n = 0;
  for (const c of usedSkills()) {
    if (n >= 6) break;
    if (addItem({ kind: "skill", id: c.skill, name: c.name, icons: c.icons })) n++;
  }
  added();
});
$(".placeBtn").addEventListener("click", () => {
  prefs.placed = true;
  save();
  renderSteps();
  (a2.overlay?.edit ? a2.overlay.edit(true) : a2.widgets.lock(false)).catch(() => {});
});
$(".hideSteps").addEventListener("click", () => {
  prefs.stepsHidden = true;
  save();
  renderSteps();
});
$(".showSteps").addEventListener("click", () => {
  prefs.stepsHidden = false;
  save();
  renderSteps();
});
// Deleting takes a second click (a sandboxed page has no confirm()).
let armed = 0;
$(".removeBar").addEventListener("click", () => {
  if (prefs.bars.length <= 1) return;
  const btn = $(".removeBar");
  if (bar().items.length && Date.now() - armed > 3000) {
    armed = Date.now();
    btn.textContent = `Click again to delete ${bar().name}`;
    setTimeout(() => (btn.textContent = "Delete this bar"), 3000);
    return;
  }
  armed = 0;
  btn.textContent = "Delete this bar";
  prefs.bars.splice(prefs.selected, 1);
  prefs.selected = Math.max(0, prefs.selected - 1);
  save();
  render();
  placeWidgets();
});
for (const [sel, key] of [[".barShape", "shape"], [".barDir", "dir"]]) {
  for (const btn of document.querySelectorAll(`${sel} button`)) {
    btn.addEventListener("click", () => {
      bar()[key] = btn.dataset.v;
      save();
      render();
      placeWidgets();
    });
  }
}
const barField = (sel, key, read, place = false) =>
  $(sel).addEventListener(sel === ".barName" || sel === ".barSize" ? "input" : "change", () => {
    bar()[key] = read($(sel));
    save();
    if (key === "name") {
      renderBarTabs();
      $(".pickBar").textContent = bar().name;
    } else {
      render();
    }
    if (place) placeWidgets();
    else sendAll();
  });
barField(".barName", "name", (e) => e.value.trim() || "Bar");
barField(".barShow", "show", (e) => e.checked, true);
barField(".barOoc", "hideOoc", (e) => e.checked);
barField(".barCooling", "onlyCooling", (e) => e.checked);
barField(".barGlow", "glow", (e) => e.checked);
barField(".barText", "text", (e) => e.checked);
barField(".barSize", "size", (e) => Number(e.value) || 44, true);

(async () => {
  const stored = await a2.storage.get("prefs").catch(() => null);
  if (stored && Array.isArray(stored.bars) && stored.bars.length) prefs = { ...prefs, ...stored };
  prefs.overrides ||= {};
  prefs.gaps ||= {};
  $(".lock").checked = await a2.widgets.locked().catch(() => false);
  render();
  renderStatus();
  await placeWidgets();
  a2.ready();
})();
