// Progression Guide: you (or a character looked up) from the official site,
// beside the strongest players of the class (a2.armory, plugins/armory.rs),
// and what to improve first (analysis.js).
const $ = (s) => document.querySelector(s);

const CLASS_IDS = { gladiator: 11, templar: 12, assassin: 13, ranger: 14, sorcerer: 15, spiritmaster: 16, elementalist: 16, cleric: 17, chanter: 18, brawler: 19, fighter: 19 };
const classIdOf = (c) => CLASS_IDS[String(c?.profile?.className || "").toLowerCase()] || 0;
const keyOf = (c) => `${c.profile?.serverId}:${c.profile?.characterName}`;
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const serverName = (id) => SERVERS.find((s) => s.id === Number(id))?.name || String(id);

let me = null; // the character shown
let own = true; // it is you, not one looked up
let pool = new Map(); // key → { source, character }
let report = null;
let tab = "overview";
let extra = []; // players added by hand: { name, server }
let character = null; // who the game says is playing

const saveExtra = () => a2.storage.set("extra", extra).catch(() => {});
function setStatus(text, error = false) {
  const el = $(".status");
  el.textContent = text || "";
  el.classList.toggle("error", !!error);
}

// ── reading ─────────────────────────────────────────────────────────────────

async function load(who, refresh = false) {
  setStatus(who ? `Reading ${who.name} from the official site…` : "Reading your character from the official site…");
  $(".refresh").disabled = true;
  try {
    me = await a2.armory.character(who ? { ...who, refresh } : { refresh });
  } catch (e) {
    me = null;
    setStatus(String(e?.message || e), true);
    renderWho();
    return;
  }
  own = !who;
  $(".refresh").disabled = false;
  pool = new Map();
  report = null;
  renderWho();
  render();
  const cls = classIdOf(me);
  if (!cls) return setStatus(`${me.profile?.className || "This class"} isn't known to the guide.`, true);
  setStatus("Finding the strongest players of the class…");
  a2.armory.pool({ class: cls, server: me.profile.serverId, extra }).catch((e) => setStatus(String(e?.message || e), true));
}

let analyseTimer = 0;
function reanalyse() {
  clearTimeout(analyseTimer);
  analyseTimer = setTimeout(() => {
    if (!me) return;
    report = analyse(me, [...pool.values()].map((p) => p.character));
    render();
  }, 300);
}

a2.on("armory-player", ({ source, character: c }) => {
  if (!me || !c?.profile || keyOf(c) === keyOf(me) || classIdOf(c) !== classIdOf(me)) return;
  pool.set(keyOf(c), { source, character: c });
  reanalyse();
});
a2.on("armory-pool", (p) => {
  if (!p) return;
  if (p.note) setStatus(`a2tools.app: ${p.note}`, true);
  if (p.stage === "reading") setStatus(`Reading the players to compare with: ${p.found} of ${p.total} found…`);
  if (p.stage === "boards") setStatus(`Reading the Daevanion boards of the players compared: ${p.found} of ${p.total}…`);
  if (p.stage === "done") {
    setStatus(
      pool.size
        ? `Compared with the strongest ${Math.max(5, Math.ceil(pool.size / 2))} of ${pool.size} ${me?.profile?.className || ""}s.${pool.size < 5 ? " Few to compare with: add players you know under Compared with." : ""}`
        : "No one of the class to compare with yet: add players under Compared with, or play with some.",
    );
    reanalyse();
  }
});
a2.on("character", (c) => {
  const changed = c?.name && c.name !== character?.name;
  character = c;
  if (changed && own) load(null);
});
a2.on("hosted", () => document.body.classList.add("hosted"));

// ── the page ────────────────────────────────────────────────────────────────

function renderWho() {
  const p = me?.profile;
  const portrait = $(".portrait");
  portrait.replaceChildren();
  if (p?.profileImage) {
    const img = new Image();
    img.src = p.profileImage;
    img.alt = "";
    img.onerror = () => img.remove();
    portrait.append(img);
  }
  $(".whoName").textContent = p ? `${p.characterName}${own ? "" : " (looked up)"}` : "Your character";
  $(".whoSub").textContent = p
    ? `${p.className} · level ${p.characterLevel} · ${p.serverName || serverName(p.serverId)} · ${p.raceName} · combat power ${p.combatPower?.toLocaleString()}`
    : "Log in to a character and the guide reads it from the official site.";
}

function render() {
  for (const b of document.querySelectorAll(".chips button")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll(".view")) v.hidden = !v.classList.contains(tab);
  if (tab === "overview") renderOverview();
  if (tab === "roadmap") renderRoadmap();
  if (tab === "gear") renderGear();
  if (tab === "daevanion") renderDaevanion();
  if (tab === "skills") renderSkills();
  if (tab === "pool") renderPool();
}

const waiting = (el) => {
  el.innerHTML = `<p class="note">${me ? "Waiting for players to compare with…" : "No character read yet."}</p>`;
};

function renderOverview() {
  const el = $(".view.overview");
  if (!report) return waiting(el);
  const stat = (label, value, sub) => `<div class="stat"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="s">${esc(sub)}</div></div>`;
  const itemLevel = me.stat?.statList?.find((s) => s.type === "ItemLevel")?.value;
  const boardsDone = report.daevanion.filter((b) => b.open);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  el.innerHTML = `
    <div class="stats">
      ${stat("Combat power", report.combatPower.toLocaleString(), `typical ${k(report.combatPowerMedian || 0)} · best ${k(report.combatPowerBest)}`)}
      ${stat("Rank among them", `${report.rank} of ${report.of}`, "by combat power")}
      ${stat("Item level", itemLevel ?? "–", "from the official site")}
      ${stat("Daevanion", `${Math.round(avg(boardsDone.map((b) => b.mine || 0)))}%`, `typical ${Math.round(avg(boardsDone.map((b) => b.median || 0)))}% across open boards`)}
    </div>
    <h3>What to improve first</h3>
    ${
      report.suggestions.length
        ? `<ol class="todo">${report.suggestions
            .slice(0, 12)
            .map((s) => `<li><span class="kind ${esc(s.kind)}">${esc(s.kind)}</span><span>${esc(s.text)}</span></li>`)
            .join("")}</ol>`
        : `<p class="note">Nothing stands out: you are on par with the players compared.</p>`
    }
    <p class="note">From ${report.top} players of your class with the most combat power. Suggestions compare numbers only: the game's own systems decide what each step costs.</p>`;
}

// Where your gear score stands on the roadmap (roadmap.js), and what gets you
// to the next milestone. Needs no players to compare with.
function renderRoadmap() {
  const el = $(".view.roadmap");
  if (!me) return waiting(el);
  const il = itemLevelOf(me);
  const m = milestoneOf(il);
  const own = roadmapChecks(me);
  const steps = (ms, open) => `<details class="milestone${open ? " now" : ""}" ${open ? "open" : ""}>
      <summary><span class="msAt">${ms.at.toLocaleString()}</span>${il >= ms.at ? '<span class="msDone">reached</span>' : open ? '<span class="msNext">next</span>' : ""}</summary>
      <ul>${ms.steps.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </details>`;
  el.innerHTML = `
    <div class="card gsCard">
      <div class="gsHead"><span class="k">Gear score</span><b class="gsNow">${il ? il.toLocaleString() : "–"}</b>
        <span class="gsTo">${m.next ? `next milestone ${m.next.at.toLocaleString()}, ${(m.next.at - il).toLocaleString()} to go` : "past every milestone here"}</span></div>
      <div class="track"><div class="mine" style="width:${(m.progress * 100).toFixed(1)}%"></div></div>
    </div>
    ${own.length ? `<h3>For your gear now</h3><ol class="todo">${own.sort((a, b) => b.score - a.score).map((s) => `<li><span class="kind ${esc(s.kind)}">${esc(s.kind)}</span><span>${esc(s.text)}</span></li>`).join("")}</ol>` : ""}
    <h3>Milestones</h3>
    ${MILESTONES.map((ms, i) => steps(ms, i === m.index)).join("")}
    <h3>Combat power gear score doesn't show</h3>
    <ul class="extras">${CP_EXTRAS.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    <p class="note">The milestones and their order follow <a href="https://raidrelay.com/aion-2-gear-score-guide">RaidRelay's AION 2 gear score guide</a>. The Daily Planner keeps the daily and weekly runs that feed them.</p>`;
}

function gradeSpan(item) {
  return item ? `<span class="grade-${esc(item.grade)}">${esc(item.name)}</span>` : "–";
}

function renderGear() {
  const el = $(".view.gear");
  if (!report) return waiting(el);
  el.innerHTML = `<table class="table"><thead><tr><th>Slot</th><th>Yours</th><th class="r">Enchant</th><th class="r">Typical</th><th>Most used by them</th></tr></thead><tbody>
    ${report.gear
      .map((g) => {
        const gap = g.mine && g.enchantMedian !== null ? (g.mine.enchantLevel || 0) - g.enchantMedian : 0;
        const cls = gap <= -2 ? "behind" : gap >= 2 ? "ahead" : "";
        return `<tr>
          <td>${esc(g.label)}</td>
          <td><div class="cell" data-icon="${esc(g.mine?.icon || "")}">${gradeSpan(g.mine)}</div></td>
          <td class="r ${cls}">${g.mine ? `+${g.mine.enchantLevel}${g.mine.exceedLevel ? ` · ex ${g.mine.exceedLevel}` : ""}` : "–"}</td>
          <td class="r">${g.enchantMedian === null ? "–" : `+${Math.round(g.enchantMedian)}`}</td>
          <td>${g.common ? `${gradeSpan(g.common)} <span class="tagline">${pct(g.commonShare)}</span>` : "–"}</td>
        </tr>`;
      })
      .join("")}</tbody></table>`;
  addIcons(el);
}

function renderDaevanion() {
  const el = $(".view.daevanion");
  if (!report) return waiting(el);
  el.innerHTML = report.daevanion
    .map((b) => {
      const kinds = effectKinds(b.missing).slice(0, 6).map(([kind, n]) => `${esc(kind)} ×${n}`).join(", ");
      const nodeList = b.missing
        .slice(0, 40)
        .map((m) => `<li>${esc((m.node.effectList || []).map((e) => e.desc).join(", ") || m.node.name || m.nodeId)} <span class="tagline">${pct(m.share)}</span></li>`)
        .join("");
      return `<div class="board">
        <div class="boardHead"><span class="cell" data-icon="${esc(b.icon || "")}"></span>${esc(b.name)}${b.open ? "" : ' <span class="tagline">not open</span>'}</div>
        <div class="track">
          <div class="mine" style="width:${b.mine || 0}%"></div>
          ${b.median !== null ? `<div class="median" style="left:${b.median}%"></div>` : ""}
          <div class="best" style="left:${b.top}%"></div>
        </div>
        <div class="legend"><span class="m">you ${b.mine ?? 0}%</span> · <span class="md">typical ${b.median === null ? "–" : Math.round(b.median) + "%"}</span> · <span class="b">best ${b.top}%</span></div>
        ${
          b.missing.length
            ? `<details class="nodes"><summary>${b.missing.length} nodes most of them take that you don't${kinds ? `: ${kinds}` : ""}</summary><ul>${nodeList}</ul></details>`
            : ""
        }
      </div>`;
    })
    .join("");
  addIcons(el);
}

function renderSkills() {
  const el = $(".view.skills");
  if (!report) return waiting(el);
  const groups = new Map();
  for (const s of report.skills) {
    const g = groups.get(s.category) || [];
    g.push(s);
    groups.set(s.category, g);
  }
  const label = { Active: "Active skills", Passive: "Passive skills", Dp: "DP skills" };
  el.innerHTML = [...groups]
    .map(
      ([cat, list]) => `<h3>${esc(label[cat] || cat)}</h3><table class="table"><thead><tr><th>Skill</th><th>Yours</th><th class="r">Level</th><th class="r">Equipped by them</th><th class="r">Their level</th></tr></thead><tbody>
      ${list
        .map((s) => {
          const mine = s.mine;
          const state = !mine?.acquired ? "not learnt" : mine.equip === 1 ? "equipped" : "not equipped";
          const flag = (s.equipShare >= 0.6 && mine?.equip !== 1) || (mine?.equip === 1 && s.equipShare <= 0.2) ? "behind" : "";
          const levelGap = mine?.equip === 1 && s.levelMedian !== null && s.levelMedian - (mine.skillLevel || 0) >= 2 ? "behind" : "";
          return `<tr>
            <td><div class="cell" data-icon="${esc(s.icon || "")}">${esc(s.name)}</div></td>
            <td class="${flag}">${state}</td>
            <td class="r ${levelGap}">${mine ? mine.skillLevel : "–"}</td>
            <td class="r">${pct(s.equipShare)}</td>
            <td class="r">${s.levelMedian === null ? "–" : Math.round(s.levelMedian)}</td>
          </tr>`;
        })
        .join("")}</tbody></table>`,
    )
    .join("");
  addIcons(el);
}

function renderPool() {
  const el = $(".poolList");
  const list = [...pool.values()].sort((a, b) => (b.character.profile.combatPower || 0) - (a.character.profile.combatPower || 0));
  const source = { leaderboard: "a2tools.app leaderboard", seen: "met in your fights", added: "added by you" };
  el.innerHTML = list.length
    ? `<table class="table"><thead><tr><th>Player</th><th>Server</th><th class="r">Combat power</th><th>From</th><th></th></tr></thead><tbody>
      ${list
        .map(
          (p, i) => `<tr><td>${esc(p.character.profile.characterName)}${i < (report?.top || 0) ? ' <span class="tagline">compared</span>' : ""}</td>
          <td>${esc(p.character.profile.serverName || serverName(p.character.profile.serverId))}</td>
          <td class="r">${(p.character.profile.combatPower || 0).toLocaleString()}</td>
          <td class="tagline">${esc(source[p.source] || p.source)}</td>
          <td>${p.source === "added" ? `<button type="button" class="btn small" data-remove="${esc(keyOf(p.character))}">×</button>` : ""}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="note">${me ? "Reading players…" : "No character read yet."}</p>`;
  for (const b of el.querySelectorAll("[data-remove]")) {
    b.addEventListener("click", () => {
      const [server, ...rest] = b.dataset.remove.split(":");
      const name = rest.join(":");
      extra = extra.filter((x) => !(x.name === name && String(x.server) === server));
      saveExtra();
      pool.delete(b.dataset.remove);
      reanalyse();
      renderPool();
    });
  }
}

// Icons: each cell names its icon in data-icon, loaded once drawn.
function addIcons(root) {
  for (const cell of root.querySelectorAll("[data-icon]")) {
    const url = cell.dataset.icon;
    if (url) cell.prepend(iconElement([url], ""));
    delete cell.dataset.icon;
  }
}

function fillServers(select) {
  const regions = new Map();
  for (const s of SERVERS) {
    const key = `${s.region} · ${s.side}`;
    if (!regions.has(key)) regions.set(key, []);
    regions.get(key).push(s);
  }
  select.replaceChildren(
    ...[...regions].map(([label, list]) => {
      const g = document.createElement("optgroup");
      g.label = label;
      // The number first: names repeat across regions and sides, and typing it picks it.
      g.append(...list.map((s) => Object.assign(document.createElement("option"), { value: s.id, textContent: `${s.id} · ${s.name} (${s.region}, ${s.side})` })));
      return g;
    }),
  );
  const mine = character?.serverId || me?.profile?.serverId;
  if (mine) select.value = String(mine);
}

for (const b of document.querySelectorAll(".chips button")) {
  b.addEventListener("click", () => {
    tab = b.dataset.tab;
    render();
  });
}
$(".refresh").addEventListener("click", () => load(own ? null : { name: me.profile.characterName, server: me.profile.serverId }, true));
$(".lookupToggle").addEventListener("click", () => {
  const form = $(".lookup");
  form.hidden = !form.hidden;
  if (!form.hidden) fillServers($(".lookupServer"));
  $(".lookupToggle").textContent = form.hidden ? "Look up a character" : own ? "Close" : "Back to you";
  if (form.hidden && !own) load(null);
});
$(".lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $(".lookupName").value.trim();
  if (name) load({ name, server: Number($(".lookupServer").value) });
});
$(".addPlayer").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $(".addName").value.trim();
  const server = Number($(".addServer").value);
  if (!name || !me) return;
  if (!extra.some((x) => x.name === name && x.server === server)) extra.push({ name, server });
  saveExtra();
  $(".addName").value = "";
  setStatus(`Reading ${name}…`);
  a2.armory.pool({ class: classIdOf(me), server: me.profile.serverId, extra: [{ name, server }] }).catch((err) => setStatus(String(err?.message || err), true));
});

(async () => {
  extra = (await a2.storage.get("extra").catch(() => null)) || [];
  fillServers($(".addServer"));
  render();
  a2.ready();
  // The character may already be known (a2.on("character") comes at start too).
  setTimeout(() => {
    if (!me) load(null);
  }, 800);
})();
