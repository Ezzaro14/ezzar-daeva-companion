// The Progression Guide's comparison: you against the strongest players of
// your class, from the official site's data (plugins/armory.rs). Plain
// functions of the characters, so they can be tested outside the page.
// A character: { profile, stat, daevanion: { boardList, boards }, equipment, skill, petwing }.

// How much a slot matters when its gap is ranked: the weapon most.
const SLOT_WEIGHT = { MainHand: 3, SubHand: 2, Torso: 1.6, Pants: 1.4, Helmet: 1.3, Shoulder: 1.3, Gloves: 1.4, Boots: 1.3, Cape: 1.2 };
const SLOT_ORDER = [
  "MainHand", "SubHand", "Helmet", "Shoulder", "Torso", "Gloves", "Pants", "Boots", "Cape", "Belt",
  "Necklace", "Earring1", "Earring2", "Ring1", "Ring2", "Bracelet1", "Bracelet2", "Amulet", "Rune1", "Rune2",
];
const SLOT_NAMES = {
  MainHand: "Main hand", SubHand: "Off hand", Earring1: "Earring", Earring2: "Earring", Ring1: "Ring", Ring2: "Ring",
  Bracelet1: "Bracelet", Bracelet2: "Bracelet", Rune1: "Rune", Rune2: "Rune",
};
// A node on most top players' boards that you lack.
const COMMON_NODE = 0.6;
// A skill most of them equip, or almost none do.
const COMMON_SKILL = 0.6;
const RARE_SKILL = 0.2;
// An item worth naming as the usual choice.
const COMMON_ITEM = 0.4;

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const share = (count, total) => (total ? count / total : 0);
const pct = (x) => `${Math.round(x * 100)}%`;
const slotName = (slot) => SLOT_NAMES[slot] || slot.replace(/([a-z])([A-Z])/g, "$1 $2");

// The players compared with: the stronger half of the pool by combat power
// (at least five, all of them if fewer), and where you would rank.
function benchmark(me, pool) {
  const sorted = [...pool].sort((a, b) => (b.profile?.combatPower || 0) - (a.profile?.combatPower || 0));
  const top = sorted.slice(0, Math.max(5, Math.ceil(sorted.length / 2)));
  const cp = me.profile?.combatPower || 0;
  const rank = sorted.filter((c) => (c.profile?.combatPower || 0) > cp).length + 1;
  return { top, all: sorted, rank, of: sorted.length + 1 };
}

const itemsBySlot = (c) => Object.fromEntries((c.equipment?.equipmentList || []).map((it) => [it.slotPosName, it]));

function gear(me, top) {
  const mine = itemsBySlot(me);
  const theirs = top.map(itemsBySlot);
  const slots = SLOT_ORDER.filter((s) => mine[s] || theirs.some((t) => t[s]));
  return slots.map((slot) => {
    const have = theirs.map((t) => t[slot]).filter(Boolean);
    const counts = new Map();
    for (const it of have) counts.set(it.name, (counts.get(it.name) || 0) + 1);
    const [commonName, commonCount] = [...counts].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const common = have.find((it) => it.name === commonName) || null;
    const my = mine[slot] || null;
    return {
      slot,
      label: slotName(slot),
      mine: my,
      enchantMedian: median(have.map((it) => it.enchantLevel)),
      exceedMedian: median(have.map((it) => it.exceedLevel || 0)),
      common,
      commonShare: share(commonCount, top.length),
      filled: share(have.length, top.length),
    };
  });
}

const boardsOf = (c) => c.daevanion?.boardList || [];
const openNodes = (c, boardId) =>
  new Set(((c.daevanion?.boards || {})[boardId]?.nodeList || []).filter((n) => n.open === 1).map((n) => n.nodeId));

function daevanion(me, top) {
  return boardsOf(me).map((board) => {
    const theirs = top.map((t) => boardsOf(t).find((b) => b.id === board.id)).filter(Boolean);
    const mineOpen = openNodes(me, board.id);
    // Each node's share among top players, and its effects (from any board read).
    const nodeCount = new Map();
    const nodeInfo = new Map();
    for (const t of top) {
      for (const n of ((t.daevanion?.boards || {})[board.id]?.nodeList || [])) {
        if (n.type !== "None" && !nodeInfo.has(n.nodeId)) nodeInfo.set(n.nodeId, n);
        if (n.open === 1) nodeCount.set(n.nodeId, (nodeCount.get(n.nodeId) || 0) + 1);
      }
    }
    const read = top.filter((t) => (t.daevanion?.boards || {})[board.id]).length;
    // Which nodes "most of them" take needs a few of their boards read.
    const enough = read >= Math.min(3, top.length);
    const missing = [...nodeCount]
      .map(([nodeId, n]) => ({ nodeId, share: share(n, read), node: nodeInfo.get(nodeId) }))
      .filter((x) => enough && x.share >= COMMON_NODE && !mineOpen.has(x.nodeId) && x.node)
      .sort((a, b) => b.share - a.share);
    return {
      id: board.id,
      name: board.name,
      icon: board.icon,
      open: board.open === 1,
      mine: board.openPercent ?? null,
      median: median(theirs.map((b) => b.openPercent)),
      top: Math.max(0, ...theirs.map((b) => b.openPercent || 0)),
      missing,
      readFrom: read,
    };
  });
}

function skills(me, top) {
  const mine = new Map((me.skill?.skillList || []).map((s) => [s.id, s]));
  const all = new Map();
  for (const t of top) for (const s of t.skill?.skillList || []) if (!all.has(s.id)) all.set(s.id, s);
  for (const s of mine.values()) if (!all.has(s.id)) all.set(s.id, s);
  return [...all.values()]
    .map((s) => {
      const theirs = top.map((t) => (t.skill?.skillList || []).find((x) => x.id === s.id)).filter(Boolean);
      const equipped = theirs.filter((x) => x.equip === 1);
      const m = mine.get(s.id) || null;
      return {
        id: s.id,
        name: s.name,
        icon: s.icon,
        category: s.category,
        mine: m,
        equipShare: share(equipped.length, top.length),
        levelMedian: median(equipped.map((x) => x.skillLevel)),
      };
    })
    .sort((a, b) => b.equipShare - a.equipShare || String(a.name).localeCompare(String(b.name)));
}

function extras(me, top) {
  const petLevel = median(top.map((t) => t.petwing?.pet?.level));
  const wings = new Map();
  for (const t of top) if (t.petwing?.wing?.name) wings.set(t.petwing.wing.name, (wings.get(t.petwing.wing.name) || 0) + 1);
  const [wingName, wingCount] = [...wings].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  return {
    pet: me.petwing?.pet || null,
    petLevelMedian: petLevel,
    wing: me.petwing?.wing || null,
    commonWing: wingName,
    commonWingShare: share(wingCount, top.length),
  };
}

// The effects of some nodes, by kind ("Attack Bonus +3" is Attack Bonus),
// most common first: [[kind, count]].
function effectKinds(missing) {
  const counts = new Map();
  for (const m of missing) {
    for (const e of m.node.effectList || []) {
      const kind = String(e.desc || "").replace(/\s*[+-]?\d+(\.\d+)?%?\s*$/, "").trim();
      if (kind) counts.set(kind, (counts.get(kind) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

// What to do, most worth it first: each with a score (bigger first), what
// it is about, and a line to show.
function suggestions(report) {
  const out = [];
  for (const g of report.gear) {
    const w = SLOT_WEIGHT[g.slot] || 1;
    if (!g.mine && g.filled >= 0.5) {
      out.push({ score: 10 * w, kind: "gear", text: `Equip something in ${g.label}: ${pct(g.filled)} of the players compared do${g.common ? ` (most: ${g.common.name})` : ""}.` });
      continue;
    }
    if (!g.mine) continue;
    const gap = (g.enchantMedian ?? 0) - (g.mine.enchantLevel || 0);
    if (gap >= 2) {
      out.push({ score: gap * w, kind: "gear", text: `Enchant ${g.label} (${g.mine.name}) from +${g.mine.enchantLevel} toward +${Math.round(g.enchantMedian)}, the usual among the players compared.` });
    }
    const exGap = (g.exceedMedian ?? 0) - (g.mine.exceedLevel || 0);
    if (exGap >= 1) {
      out.push({ score: exGap * 1.5 * w, kind: "gear", text: `Raise ${g.label}'s exceed level from ${g.mine.exceedLevel || 0} toward ${Math.round(g.exceedMedian)}.` });
    }
    if (g.common && g.common.name !== g.mine.name && g.commonShare >= COMMON_ITEM) {
      out.push({ score: 2.5 * w * g.commonShare, kind: "gear", text: `${g.label}: ${pct(g.commonShare)} of the players compared use ${g.common.name} (${g.common.grade}); you have ${g.mine.name} (${g.mine.grade}).` });
    }
  }
  for (const b of report.daevanion) {
    if (!b.open) {
      if (b.median !== null && b.median > 0) out.push({ score: 6, kind: "daevanion", text: `Open the ${b.name} board: the players compared have it ${Math.round(b.median)}% done.` });
      continue;
    }
    const gap = (b.median ?? 0) - (b.mine ?? 0);
    if (gap >= 10) out.push({ score: gap / 4, kind: "daevanion", text: `${b.name} board: ${b.mine}% done; the players compared are at ${Math.round(b.median)}%.` });
    if (b.missing.length) {
      const kinds = effectKinds(b.missing)
        .slice(0, 3)
        .map(([kind, n]) => `${kind} ×${n}`)
        .join(", ");
      out.push({ score: Math.min(8, 0.3 * b.missing.length), kind: "daevanion", text: `${b.name}: ${b.missing.length} nodes most of them take that you don't${kinds ? `, mostly ${kinds}` : ""}.` });
    }
  }
  for (const s of report.skills) {
    if (s.equipShare >= COMMON_SKILL && s.mine && s.mine.equip !== 1) {
      out.push({ score: 4 * s.equipShare, kind: "skill", text: `Equip ${s.name}: ${pct(s.equipShare)} of the players compared do.` });
    } else if (s.equipShare >= COMMON_SKILL && !s.mine?.acquired) {
      out.push({ score: 3 * s.equipShare, kind: "skill", text: `Learn ${s.name}: ${pct(s.equipShare)} of the players compared use it.` });
    }
    if (s.mine?.equip === 1 && s.equipShare <= RARE_SKILL && report.top >= 5) {
      out.push({ score: 1.5, kind: "skill", text: `${s.name} is equipped by only ${pct(s.equipShare)} of the players compared: worth a second look.` });
    }
    if (s.mine?.equip === 1 && s.levelMedian !== null && s.levelMedian - (s.mine.skillLevel || 0) >= 2) {
      out.push({ score: (s.levelMedian - s.mine.skillLevel) * 0.8, kind: "skill", text: `Raise ${s.name} from level ${s.mine.skillLevel} toward ${Math.round(s.levelMedian)}.` });
    }
  }
  const e = report.extras;
  if (e.pet && e.petLevelMedian !== null && e.petLevelMedian - (e.pet.level || 0) >= 1) {
    out.push({ score: 2, kind: "pet", text: `Level ${e.pet.name} from ${e.pet.level} toward ${Math.round(e.petLevelMedian)}.` });
  }
  if (e.commonWing && e.wing?.name !== e.commonWing && e.commonWingShare >= COMMON_ITEM) {
    out.push({ score: 2, kind: "wings", text: `${pct(e.commonWingShare)} of the players compared fly ${e.commonWing}; you have ${e.wing?.name || "none"}.` });
  }
  return out.sort((a, b) => b.score - a.score);
}

// The whole comparison of `me` with `pool` (characters of the same class).
function analyse(me, pool) {
  const b = benchmark(me, pool);
  const report = {
    top: b.top.length,
    rank: b.rank,
    of: b.of,
    combatPower: me.profile?.combatPower || 0,
    combatPowerMedian: median(b.top.map((c) => c.profile?.combatPower)),
    combatPowerBest: Math.max(0, ...b.all.map((c) => c.profile?.combatPower || 0)),
    gear: gear(me, b.top),
    daevanion: daevanion(me, b.top),
    skills: skills(me, b.top),
    extras: extras(me, b.top),
  };
  // With the roadmap's checks on your own gear (roadmap.js).
  const own = typeof roadmapChecks === "function" ? roadmapChecks(me) : [];
  report.suggestions = [...suggestions(report), ...own].sort((a, b) => b.score - a.score);
  return report;
}

if (typeof module !== "undefined") module.exports = { analyse, median, benchmark, effectKinds };
