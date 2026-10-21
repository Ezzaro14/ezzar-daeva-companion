// The gear score roadmap: milestones, what gets you to each, and checks on
// your own gear that need no comparison. After RaidRelay's AION 2 gear score
// guide (raidrelay.com/aion-2-gear-score-guide, 2026). Plain functions of a
// character, like analysis.js.

const MILESTONES = [
  {
    at: 1000,
    steps: [
      "Spiritforged weapon and guard to +10 (the weapon takes about 406k Kina and 16k Enhance Stones).",
      "Fill every accessory and rune slot: regional quests give them (Pilgrim and Liberator pieces are item level 43).",
      "Clash Runes: enchant to +1 and stop. From +2 a failed enchant destroys the rune.",
      "Belt and amulet: Rare +0 to +10, then Substance Morph to the next grade (about +23 each).",
      "Spend your Daevanion Crystals (+1 each). Empyrean Traces raise the amulet.",
      "Any other quest gear: +5 at most, it gets replaced.",
    ],
  },
  {
    at: 1400,
    steps: [
      "Finish the main story, and the Pilgrim or Liberator set (to +5 at most).",
      "Belt and amulet: to +10 again, then morph to Unique (about +58 for both).",
      "Regional quests and sealed dungeons give Daevanion Crystals (2 each).",
      "Sockets: at least two gray lines and one green on each piece (gray +1, green +2, blue +3, yellow +4).",
      "Crystals from Nightmare's Trade Shop (50) and Shugo Festival's shop (20).",
      "Stigma Shards (Abyss Points) until your main Stigma skills are level 20.",
      "Keep your Odyle Energy until 1,400: Urugugu Canyon and Vakron pay half as much again as Draupnir for it.",
    ],
  },
  {
    at: 1600,
    steps: [
      "Vakron Conquest first: a guaranteed reward every 21 claims; two vouchers and 1.5M Kina craft the guard.",
      "Armour before the guard: two armour pieces at +5 add about twice what the guard at +10 does.",
      "After the second guaranteed reward (42 claims), Urugugu Canyon: its Unique accessories are item level 70.",
    ],
  },
  {
    at: 1900,
    steps: [
      "Transcendence stage 1: all five Arcana slots, from Deus Research Base and Shattered Arkanis (Common cards are 20 each).",
      "Craft the Chalice first, with a Transmute: it has the widest skill pool.",
      "Mysterious Crystals: 5 a season from the Ascension Trial.",
    ],
  },
  {
    at: 2100,
    steps: [
      "Transcendence stage 2: Epic cards (60 each, +1 per card level).",
      "Only with spare Kina: guard and weapon to +12.",
      "Don't re-engrave stat lines yet.",
    ],
  },
  {
    at: 2200,
    steps: [
      "Fire Temple and Ferocious Horn Den: item level 86 Unique gear, +16 a piece over Vakron or Urugugu.",
      "Fire Temple: a guaranteed reward every 28 claims. Horn Den: the third voucher guarantees the Nuakum Guard.",
    ],
  },
  {
    at: 2500,
    steps: [
      "Skip Transcendence stage 3 where you can: stage 4 drops about five times the Unique cards per Odyle claim.",
      "Item level 86 gear from +5 to +10.",
    ],
  },
  {
    at: 2800,
    steps: [
      "Stage 4 Unique cards (80 each), levelled to +5.",
      "Re-engrave stat lines to yellow (+3 each over gray).",
      "Kromede and Nuakum gear to +15 last: the least gear score per Kina of anything.",
      "Past 2,800: crafted gear, and the Ludra raid.",
    ],
  },
];

// Combat power that gear score doesn't show.
const CP_EXTRAS = [
  "Titles for PvE damage: Unbound by Genus +4.5% (every Genus board at Insight 10), Scenery Collector +3.3%, Teleportation Specialist +3.1%, Guardian of Verteron or Altgard +3%.",
  "Pets: five souls unlock one; each Genus board to Insight 10.",
  "Wings you own add stats even when not worn; Conquest bosses drop sealed wings.",
  "Pantheon: statues and artworks add deity stats. Every Kibelisk teleport (61) gives the Kibelisk statue.",
  "Power Shards, Courage Scrolls, Battle Enhance Scrolls and food for hard fights.",
];

const PVE_TITLES = [
  ["Unbound by Genus", 4.5],
  ["Scenery Collector", 3.3],
  ["Teleportation Specialist", 3.1],
  ["Guardian of Verteron", 3],
  ["Guardian of Altgard", 3],
];

const GRADE_NEXT = { Common: "Rare", Rare: "Legend", Legend: "Unique" };
const QUEST_GEAR = /\b(Pilgrim|Liberator|Drifter|Avenger)\b/;
const ACCESSORY_SLOTS = ["Necklace", "Earring1", "Earring2", "Ring1", "Ring2", "Bracelet1", "Bracelet2", "Belt", "Amulet", "Rune1", "Rune2"];
const ACCESSORY_NAMES = { Earring1: "earring", Earring2: "earring", Ring1: "ring", Ring2: "ring", Bracelet1: "bracelet", Bracelet2: "bracelet", Rune1: "rune", Rune2: "rune" };

const itemLevelOf = (c) => Number(c?.stat?.statList?.find((s) => s.type === "ItemLevel")?.value) || 0;

// Where a gear score stands: the milestone reached, the next, and how far.
function milestoneOf(itemLevel) {
  const next = MILESTONES.find((m) => itemLevel < m.at) || null;
  const i = next ? MILESTONES.indexOf(next) : MILESTONES.length;
  const from = i > 0 ? MILESTONES[i - 1].at : 0;
  const to = next ? next.at : from;
  return { next, index: i, from, to, progress: next ? Math.max(0, Math.min(1, (itemLevel - from) / (to - from))) : 1 };
}

const listOf = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] || "");

// Checks on `me` alone: what the roadmap says to do with what you have.
function roadmapChecks(me) {
  const out = [];
  const items = Object.fromEntries((me.equipment?.equipmentList || []).map((it) => [it.slotPosName, it]));
  const itemLevel = itemLevelOf(me);

  const empty = ACCESSORY_SLOTS.filter((s) => !items[s]).map((s) => ACCESSORY_NAMES[s] || s.toLowerCase());
  if (empty.length) {
    const names = [...new Set(empty)];
    out.push({ score: 14, kind: "gear", text: `Fill your empty ${listOf(names)} slot${empty.length > 1 ? "s" : ""}: empty accessory and rune slots are the biggest gear score gap. Regional quests give them.` });
  }

  const bareRunes = ["Rune1", "Rune2"].map((s) => items[s]).filter((it) => it && !(it.enchantLevel > 0));
  if (bareRunes.length) {
    out.push({ score: 5, kind: "gear", text: `Enchant your ${bareRunes.length > 1 ? "runes" : bareRunes[0].name} to +1, and stop there: from +2 a failed enchant destroys a rune.` });
  }

  for (const slot of ["Belt", "Amulet"]) {
    const it = items[slot];
    const next = it && GRADE_NEXT[it.grade];
    if (!next) continue;
    if ((it.enchantLevel || 0) >= 10) {
      out.push({ score: 9, kind: "gear", text: `Your ${slot.toLowerCase()} (${it.name}) is at +10: Substance Morph it to ${next} +0 now, for its next gear score step.` });
    } else {
      out.push({ score: 4 + (it.enchantLevel || 0) * 0.3, kind: "gear", text: `Enchant your ${slot.toLowerCase()} (${it.name}, ${it.grade} +${it.enchantLevel || 0}) to +10, then Substance Morph it to ${next}.` });
    }
  }

  for (const slot of ["MainHand", "SubHand"]) {
    const it = items[slot];
    if (it && /Spiritforged/.test(it.name) && (it.enchantLevel || 0) < 10) {
      const why = itemLevel && itemLevel >= 1000 ? "it's part of reaching 1,400, until Vakron or later gear replaces it" : "the first big step toward 1,000";
      out.push({ score: slot === "MainHand" ? 8 : 6, kind: "gear", text: `Take ${it.name} from +${it.enchantLevel || 0} to +10: ${why}.` });
    }
  }

  const overQuest = Object.values(items).filter((it) => QUEST_GEAR.test(it.name) && it.enchantLevel > 5);
  if (overQuest.length && (!itemLevel || itemLevel < 1600)) {
    out.push({ score: 1, kind: "gear", text: `${listOf(overQuest.map((it) => it.name))}: quest gear past +5 is Kina spent on something you'll replace. Put the next enchants into the gear you'll keep.` });
  }

  const stigmas = (me.skill?.skillList || []).filter((s) => s.category === "Dp" && s.equip === 1 && (s.skillLevel || 0) < 20);
  if (stigmas.length) {
    const named = stigmas.slice(0, 4).map((s) => `${s.name} (${s.skillLevel})`);
    out.push({ score: 6, kind: "skill", text: `Raise your Stigma skills to level 20 with Stigma Shards (Abyss Points): ${listOf(named)}${stigmas.length > 4 ? " and more" : ""}. Combat power that gear score doesn't show.` });
  }

  const owned = new Set((me.title?.titleList || []).map((t) => t.name));
  const best = PVE_TITLES.find(([name]) => owned.has(name));
  const better = PVE_TITLES.filter(([name, pct]) => !owned.has(name) && (!best || pct > best[1]));
  if (better.length && (me.title?.titleList || []).length) {
    const [name, pct] = better[0];
    out.push({ score: 2.5, kind: "title", text: `Title worth getting: ${name} (+${pct}% PvE damage)${best ? `, over your ${best[0]} (+${best[1]}%)` : ""}.` });
  }

  if (itemLevel && itemLevel < 1400) {
    out.push({ score: 1.5, kind: "routine", text: "Below gear score 1,400: save Odyle Energy for Urugugu Canyon or Vakron, and don't skip Spacetime Rifts or the Shugo Festival." });
  }
  return out;
}

if (typeof module !== "undefined") module.exports = { MILESTONES, CP_EXTRAS, milestoneOf, roadmapChecks, itemLevelOf };
