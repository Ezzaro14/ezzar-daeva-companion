//! The combat feed: what the bundled overlays (Combat Assist, Alerts, PvP,
//! Personal Bests) need beyond what plugin decoders give. Your own skill
//! uses, for cooldowns; the buffs and debuffs live on you and your party; the
//! players you trade blows with.
//!
//! Fork addition, kept to this file and a few hooks in `DataStorage`
//! (`feed_*`), so upstream changes to the parser merge without conflict.
//!
//! - **Casts.** No record says a skill went on cooldown, so a cast is read
//!   from its effects: your first hit, miss, heal or applied abnormal with a
//!   skill after a quiet `CAST_GAP_MS` for that skill. The shortest time
//!   between two casts of a skill is its cooldown as far as the feed knows
//!   (`minGapMs`); the overlay keeps it and lets the player set their own.
//! - **Abnormals.** The live instances of the buff timeline, grouped by
//!   entity and abnormal (a stack each), for you and your party only. Each
//!   says whether a party member applied it, which tells a party's debuff
//!   from a monster's, and which loss of control it is, by its icon.
//! - **Training.** Your damage on training dummies by skill, added up since
//!   the meter started: a timed run is the difference between two snapshots.
//! - **Positions.** A buff or debuff record ends with its caster's position
//!   (`capture::abnormal`): yours, your party's and any monster's that casts
//!   one, on the map you are on, for the world map.
//! - **PvP.** Hits between you and another player (or their summon) outside
//!   your party: the game sends a heal on an ally as the same record as a
//!   blow, and a party is who you heal. A session starts with the first such
//!   hit and ends after `PVP_SESSION_IDLE_MS` without one.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use parking_lot::Mutex;
use serde::Serialize;

use crate::capture::abnormal;
use crate::entity::job_class::JobClass;

/// Hits of one skill closer together than this are one cast (multi-hits,
/// channels, a spell's several targets).
const CAST_GAP_MS: i64 = 1_200;
/// The shortest gap kept as a cooldown: anything shorter is a chain or
/// a skill without one.
const MIN_COOLDOWN_MS: i64 = 2_000;
/// The longest gap kept as a cooldown; longer is just not used for a while.
const MAX_COOLDOWN_MS: i64 = 600_000;
/// In combat until this long after the last hit by or on you.
const COMBAT_LINGER_MS: i64 = 6_000;
/// A PvP session ends this long after its last hit.
const PVP_SESSION_IDLE_MS: i64 = 60_000;
/// The window of the biggest burst.
const BURST_WINDOW_MS: i64 = 5_000;
/// Skills kept, most recently cast first.
const MAX_CASTS: usize = 96;
/// Opponents kept in a session.
const MAX_OPPONENTS: usize = 64;
/// Positions kept, and how long a monster's stays on the map.
const MAX_POSITIONS: usize = 2048;
const NPC_POSITION_MS: i64 = 90_000;
const PLAYER_POSITION_MS: i64 = 15 * 60_000;

const ICON_BASE: &str = "https://assets.playnccdn.com/static-aion2-gamedata/resources";

/// Loss-of-control kinds, by the abnormal's icon (`abnormals.json`): the
/// game's icon names say what holds you (`ICON_Abnormal_Stun`, ...).
const CONTROL_ICONS: &[(&str, &str)] = &[
    ("Stun", "stun"),
    ("Sleep", "sleep"),
    ("Fear", "fear"),
    ("Knockdown", "knockdown"),
    ("Airborne", "airborne"),
    ("Stumble", "stumble"),
    ("Bind", "bind"),
    ("HOLD", "root"),
    ("Entangle", "root"),
    ("Frozen", "freeze"),
    ("Stone", "petrify"),
    ("Charming", "charm"),
    ("Polymorph", "polymorph"),
    ("Silence", "silence"),
];

/// Which loss of control an abnormal icon stands for, if any. `CharmingArrow`
/// is a Ranger's buff, not a charm.
pub fn control_kind(icon: &str) -> Option<&'static str> {
    if icon.contains("CharmingArrow") || icon.contains("Immune") {
        return None;
    }
    let tail = icon.rsplit("Abnormal_").next().unwrap_or(icon);
    CONTROL_ICONS.iter().find(|(name, _)| tail.starts_with(name)).map(|&(_, kind)| kind)
}

/// Icons of effects that hurt: damage over time, "…Down" stats, poisons and
/// bleeds, marks and the like, by the part after `Abnormal_`. Loss of
/// control counts too (`control_kind`).
const HARMFUL_ICONS: &[&str] = &[
    "Dot", "Poison", "Bleed", "bleed", "Burn", "TargetMark", "Bomb", "FlightDisabled", "Scar", "Curse",
    "Blind", "Slow", "Link", "CoolTimeIncrease", "Groggy", "Blockade", "StealLife", "StealMana",
    "PoisonBlood", "Betrayal", "Spore", "CAPTCHA_Debuff", "MaxHPMPDown", "HpHealDown",
];

/// Whether an abnormal icon is a debuff: something an enemy would put on you
/// to hurt you. Items (scrolls, food, potions), rewards (Abyss Tier, ranking),
/// stat "…Up"s, barriers and class skills' own icons are not, so a reward
/// the whole party has never reads as an enemy's debuff on it.
pub fn is_debuff(icon: &str) -> bool {
    let item = icon.starts_with("Icon_Item") || icon.starts_with("Icon_Usable") || icon.starts_with("Icon_Currency");
    if item || icon.contains("RankingReward") || icon.contains("Benefit") || icon.contains("_SKILL") {
        return false;
    }
    if control_kind(icon).is_some_and(|kind| kind != "polymorph") {
        return true;
    }
    let tail = icon.rsplit("Abnormal_").next().unwrap_or(icon);
    tail.contains("Down") || HARMFUL_ICONS.iter().any(|h| tail.starts_with(h))
}

/// A skill code without its level and specialization digits (`11020007` is
/// a cast of `11020000`), the key cooldowns are kept under.
pub fn base_skill(code: i32) -> i32 {
    if (10_000_000..=19_999_999).contains(&code) { code - code % 10_000 } else { code }
}

/// The game data the feed names things with: icons and abnormal names.
#[derive(Default)]
pub struct FeedData {
    /// First four digits of a skill code -> icon file (`skill_icons.json`).
    skill_icons: HashMap<String, String>,
    /// Abnormal id -> icon file (`abnormals.json`).
    abnormal_icons: HashMap<u32, String>,
    /// Abnormal id -> name, in the meter's language.
    abnormal_names: HashMap<u32, String>,
    /// Skill code -> name, in the meter's language.
    skill_names: HashMap<i32, String>,
    /// Dungeon (instance) id -> name and difficulty.
    dungeons: HashMap<i32, (String, Option<String>)>,
    /// NPC code -> name, and whether it is a boss.
    npcs: HashMap<i32, (String, bool)>,
}

impl FeedData {
    /// Read the tables from the meter's data folder; what does not read stays empty.
    pub fn load(dir: &Path, lang: &str) -> Self {
        let read = |path: std::path::PathBuf| -> serde_json::Value {
            std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
        };
        let named = |kind: &str| {
            let own = read(dir.join("i18n").join(kind).join(format!("{lang}.json")));
            if own.as_object().is_some_and(|o| !o.is_empty()) { own } else { read(dir.join("i18n").join(kind).join("en.json")) }
        };
        let mut data = FeedData::default();
        if let Some(map) = read(dir.join("skill_icons.json")).as_object() {
            data.skill_icons = map.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect();
        }
        if let Some(map) = read(dir.join("abnormals.json"))["abnormals"].as_object() {
            data.abnormal_icons = map
                .iter()
                .filter_map(|(k, v)| Some((k.parse().ok()?, v["icon"].as_str()?.to_string())))
                .collect();
        }
        if let Some(map) = named("abnormals").as_object() {
            data.abnormal_names = map.iter().filter_map(|(k, v)| Some((k.parse().ok()?, v.as_str()?.to_string()))).collect();
        }
        if let Some(map) = named("skills").as_object() {
            data.skill_names = map.iter().filter_map(|(k, v)| Some((k.parse().ok()?, v.as_str()?.to_string()))).collect();
        }
        if let Some(map) = named("npcs").as_object() {
            data.npcs = map
                .iter()
                .filter_map(|(k, v)| Some((k.parse().ok()?, (v["name"].as_str()?.to_string(), v["isBoss"].as_bool().unwrap_or(false)))))
                .collect();
        }
        if let Some(map) = named("dungeons").as_object() {
            data.dungeons = map
                .iter()
                .filter_map(|(k, v)| {
                    Some((k.parse().ok()?, (v["name"].as_str()?.to_string(), v["difficulty"].as_str().map(str::to_string))))
                })
                .collect();
        }
        data
    }

    fn skill_name(&self, code: i32) -> String {
        self.skill_names
            .get(&code)
            .or_else(|| self.skill_names.get(&base_skill(code)))
            .cloned()
            .unwrap_or_default()
    }

    /// Icon URLs to try in order, as the meter's `skillIcons.js` picks them.
    fn skill_icons(&self, code: i32) -> Vec<String> {
        let digits = code.to_string();
        if digits.len() < 4 {
            return Vec::new();
        }
        match self.skill_icons.get(&digits[..4]) {
            Some(icon) => vec![format!("{ICON_BASE}/{icon}.png")],
            None => Vec::new(),
        }
    }

    fn abnormal_icons(&self, abnormal: u32, skill: Option<u32>) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(icon) = self.abnormal_icons.get(&abnormal) {
            out.push(format!("{ICON_BASE}/{icon}.png"));
            for suffix in ["_Buff", "_Debuff"] {
                if let Some(plain) = icon.strip_suffix(suffix) {
                    out.push(format!("{ICON_BASE}/{plain}.png"));
                }
            }
        }
        if let Some(skill) = skill.and_then(|s| i32::try_from(s).ok()) {
            out.extend(self.skill_icons(skill));
        }
        out
    }
}

#[derive(Debug, Clone, Default)]
struct Cast {
    /// When the current cast began, and its last hit.
    start_ms: i64,
    last_ms: i64,
    uses: u32,
    /// The shortest time between two casts seen, within the cooldown bounds.
    min_gap_ms: Option<i64>,
    /// The time between the last two casts.
    last_gap_ms: Option<i64>,
}

#[derive(Debug, Clone, Default)]
struct Opponent {
    dealt: i64,
    taken: i64,
    hits_dealt: u32,
    hits_taken: u32,
    first_ms: i64,
    last_ms: i64,
    class: Option<JobClass>,
    /// Your damage on them by skill, and theirs on you.
    skills_dealt: HashMap<i32, i64>,
    skills_taken: HashMap<i32, i64>,
    /// Counted as your kill.
    killed: bool,
}

#[derive(Debug, Default)]
struct Pvp {
    session: u64,
    since_ms: i64,
    last_ms: i64,
    opponents: HashMap<i32, Opponent>,
    /// Your hits on opponents in the last `BURST_WINDOW_MS`, and their sum.
    recent: VecDeque<(i64, i64)>,
    recent_sum: i64,
    burst: i64,
    kills: u32,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HitTotals {
    pub damage: i64,
    pub hits: u32,
    pub crit: u32,
    pub back: u32,
    pub perfect: u32,
    pub double: u32,
}

impl HitTotals {
    fn add(&mut self, hit: &Hit) {
        self.damage += hit.damage;
        self.hits += 1;
        self.crit += hit.crit as u32;
        self.back += hit.back as u32;
        self.perfect += hit.perfect as u32;
        self.double += hit.double as u32;
    }
}

#[derive(Debug, Default)]
struct Dummy {
    total: HitTotals,
    /// Per skill, with whether it was a tick.
    skills: HashMap<(i32, bool), HitTotals>,
    first_ms: i64,
    last_ms: i64,
}

#[derive(Debug, Default)]
struct Inner {
    me: Option<i32>,
    casts: HashMap<i32, Cast>,
    dummy: Dummy,
    last_combat_ms: i64,
    pvp: Pvp,
    /// Your party's entities, as the last snapshot found them.
    party: HashSet<i32>,
    /// The dungeon you are in (0: none) and since when.
    dungeon: (i32, i64),
    /// Each entity's last position on the map, and when; the map they are on.
    positions: HashMap<i32, (f32, f32, f32, i64)>,
    positions_map: i32,
}

/// See the module docs. One per `DataStorage`.
#[derive(Default)]
pub struct CombatFeed {
    inner: Mutex<Inner>,
}

/// One hit as `DataStorage` saw it, summons resolved to their owners.
#[derive(Debug, Clone, Copy)]
pub struct Hit {
    pub ms: i64,
    /// The local player, if known.
    pub me: Option<i32>,
    pub actor: i32,
    pub target: i32,
    pub actor_is_player: bool,
    pub target_is_player: bool,
    pub skill: i32,
    pub damage: i64,
    pub dot: bool,
    /// The target is a training dummy.
    pub target_is_dummy: bool,
    pub crit: bool,
    pub back: bool,
    pub perfect: bool,
    pub double: bool,
}

impl CombatFeed {
    /// A damage (or heal) record.
    pub fn note_hit(&self, hit: Hit) {
        let Some(me) = hit.me else { return };
        let mut inner = self.inner.lock();
        switch_to(&mut inner, me);
        if hit.actor == me || hit.target == me {
            inner.last_combat_ms = inner.last_combat_ms.max(hit.ms);
        }
        if hit.actor == me && !hit.dot && hit.skill > 0 {
            note_cast(&mut inner.casts, hit.skill, hit.ms);
        }
        if hit.actor == me && hit.target_is_dummy && hit.damage > 0 {
            let dummy = &mut inner.dummy;
            if dummy.total.hits == 0 {
                dummy.first_ms = hit.ms;
            }
            dummy.last_ms = dummy.last_ms.max(hit.ms);
            dummy.total.add(&hit);
            dummy.skills.entry((base_skill(hit.skill), hit.dot)).or_default().add(&hit);
        }
        let other = if hit.actor == me && hit.target_is_player {
            Some(hit.target)
        } else if hit.target == me && hit.actor_is_player {
            Some(hit.actor)
        } else {
            None
        };
        if let Some(other) = other.filter(|o| *o != me && !inner.party.contains(o)) {
            if hit.damage > 0 {
                note_pvp(&mut inner.pvp, hit, me, other);
            }
        }
    }

    /// A cast without damage: a miss, a heal, an abnormal you applied.
    pub fn note_cast(&self, me: Option<i32>, skill: i32, ms: i64) {
        let Some(me) = me else { return };
        if skill <= 0 {
            return;
        }
        let mut inner = self.inner.lock();
        switch_to(&mut inner, me);
        note_cast(&mut inner.casts, skill, ms);
    }

    /// Where an entity was when it cast a buff or debuff.
    pub fn note_position(&self, entity: i32, x: f32, y: f32, z: f32, ms: i64) {
        if !(x.is_finite() && y.is_finite()) {
            return;
        }
        let mut inner = self.inner.lock();
        if inner.positions.len() >= MAX_POSITIONS && !inner.positions.contains_key(&entity) {
            if let Some(oldest) = inner.positions.iter().min_by_key(|(_, p)| p.3).map(|(k, _)| *k) {
                inner.positions.remove(&oldest);
            }
        }
        inner.positions.insert(entity, (x, y, z, ms));
    }

    /// Your party's entities, who are never opponents.
    pub fn set_party(&self, ids: HashSet<i32>) {
        self.inner.lock().party = ids;
    }

    /// Forget everything (a reset).
    pub fn clear(&self) {
        *self.inner.lock() = Inner::default();
    }

    /// What the overlays see now. `dead` tells whether an entity is down;
    /// `deaths_of_me` counts your deaths since a time.
    /// When the last hit of any fight was (capture time, ms; 0 for none).
    pub fn last_combat_ms(&self) -> i64 {
        self.inner.lock().last_combat_ms
    }

    pub fn snapshot(&self, now_ms: i64, ctx: &SnapshotContext<'_>) -> Snapshot {
        let mut inner = self.inner.lock();
        let me = ctx.me.or(inner.me);
        inner.party = ctx.party.iter().map(|p| p.id).collect();
        if inner.dungeon.0 != ctx.dungeon_id {
            inner.dungeon = (ctx.dungeon_id, now_ms);
        }
        // Entity ids start over on another map.
        if inner.positions_map != ctx.map_id {
            inner.positions_map = ctx.map_id;
            inner.positions.clear();
        }
        let party_ids: HashSet<i32> = ctx.party.iter().map(|p| p.id).collect();
        let mut positions: Vec<PositionView> = inner
            .positions
            .iter()
            .filter_map(|(&entity, &(x, y, z, ms))| {
                let kind = if Some(entity) == me {
                    "me"
                } else if party_ids.contains(&entity) {
                    "party"
                } else {
                    "npc"
                };
                let max_age = if kind == "npc" { NPC_POSITION_MS } else { PLAYER_POSITION_MS };
                if now_ms - ms > max_age {
                    return None;
                }
                let code = if kind == "npc" { (ctx.mob_code_of)(entity) } else { None };
                // A player not in your party: left out (only you and yours are shown).
                if kind == "npc" && code.is_none() {
                    return None;
                }
                let (name, boss) = match code.and_then(|c| ctx.data.npcs.get(&c)) {
                    Some((n, b)) => (n.clone(), *b),
                    None if kind == "party" => (ctx.party.iter().find(|p| p.id == entity).map(|p| p.name.clone()).unwrap_or_default(), false),
                    None => (String::new(), false),
                };
                Some(PositionView { entity, kind, x, y, z, ms, npc: code, name, boss })
            })
            .collect();
        positions.sort_by_key(|p| std::cmp::Reverse(p.ms));
        let dungeon = (inner.dungeon.0 > 0).then(|| {
            let (name, difficulty) = ctx.data.dungeons.get(&inner.dungeon.0).cloned().unwrap_or_default();
            DungeonView { id: inner.dungeon.0, name, difficulty, entered_ms: inner.dungeon.1 }
        });

        let mut casts: Vec<(i32, Cast)> = inner.casts.iter().map(|(k, c)| (*k, c.clone())).collect();
        casts.sort_by_key(|(_, c)| std::cmp::Reverse(c.start_ms));
        let casts = casts
            .into_iter()
            .take(MAX_CASTS)
            .map(|(skill, c)| CastView {
                skill,
                name: ctx.data.skill_name(skill),
                icons: ctx.data.skill_icons(skill),
                last_cast_ms: c.start_ms,
                uses: c.uses,
                min_gap_ms: c.min_gap_ms,
                last_gap_ms: c.last_gap_ms,
            })
            .collect();

        // Live abnormals on you and your party, a stack per instance.
        let mut grouped: HashMap<(i32, u32), AbnormalView> = HashMap::new();
        let watched: HashSet<i32> = ctx.party.iter().map(|p| p.id).chain(me).collect();
        for i in ctx.abnormals {
            if !watched.contains(&i.entity) || i.end_ms.is_some() {
                continue;
            }
            // A timer the server said ran out, where no record closed it yet.
            if i.server_end_ms.is_some_and(|end| end + 500 < now_ms) {
                continue;
            }
            let icon = ctx.data.abnormal_icons.get(&i.abnormal).cloned().unwrap_or_default();
            let entry = grouped.entry((i.entity, i.abnormal)).or_insert_with(|| AbnormalView {
                entity: i.entity,
                own: Some(i.entity) == me,
                abnormal: i.abnormal,
                name: ctx.data.abnormal_names.get(&i.abnormal).cloned().unwrap_or_default(),
                icons: ctx.data.abnormal_icons(i.abnormal, i.skill),
                control: control_kind(&icon),
                debuff: is_debuff(&icon),
                skill: i.skill,
                caster: i.caster,
                by_me: Some(i.caster) == me,
                by_party: Some(i.caster) == me || watched.contains(&i.caster),
                stacks: 0,
                start_ms: i.start_ms,
                end_ms: i.server_end_ms,
                endless: i.endless,
            });
            entry.stacks += 1;
            entry.start_ms = entry.start_ms.max(i.start_ms);
            entry.end_ms = match (entry.end_ms, i.server_end_ms) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
        }
        let mut abnormals: Vec<AbnormalView> = grouped.into_values().collect();
        abnormals.sort_by_key(|a| (!a.own, a.entity, a.start_ms));

        // PvP: a session over is kept until the next one starts, for the
        // overlay to save; kills are counted as opponents go down.
        let pvp = &mut inner.pvp;
        for (id, o) in pvp.opponents.iter_mut() {
            if !o.killed && o.dealt > 0 && (ctx.dead)(*id) {
                o.killed = true;
                pvp.kills += 1;
            }
        }
        let mut opponents: Vec<OpponentView> = pvp
            .opponents
            .iter()
            .map(|(id, o)| {
                let top = |m: &HashMap<i32, i64>| {
                    let mut v: Vec<SkillDamage> = m
                        .iter()
                        .map(|(s, d)| SkillDamage { skill: *s, name: ctx.data.skill_name(*s), damage: *d })
                        .collect();
                    v.sort_by_key(|s| std::cmp::Reverse(s.damage));
                    v.truncate(12);
                    v
                };
                OpponentView {
                    id: *id,
                    name: (ctx.name_of)(*id).unwrap_or_default(),
                    class_id: o.class.map(|c| c.class_prefix()),
                    hp: (ctx.hp_of)(*id),
                    dead: (ctx.dead)(*id),
                    killed: o.killed,
                    dealt: o.dealt,
                    taken: o.taken,
                    hits_dealt: o.hits_dealt,
                    hits_taken: o.hits_taken,
                    first_ms: o.first_ms,
                    last_ms: o.last_ms,
                    skills_dealt: top(&o.skills_dealt),
                    skills_taken: top(&o.skills_taken),
                }
            })
            .collect();
        opponents.sort_by_key(|o| std::cmp::Reverse(o.last_ms));
        let pvp_view = PvpView {
            session: pvp.session,
            active: pvp.session > 0 && now_ms - pvp.last_ms < PVP_SESSION_IDLE_MS,
            since_ms: pvp.since_ms,
            last_ms: pvp.last_ms,
            kills: pvp.kills,
            deaths: if pvp.session > 0 { (ctx.deaths_of_me)(pvp.since_ms) } else { 0 },
            burst: pvp.burst,
            dealt: pvp.opponents.values().map(|o| o.dealt).sum(),
            taken: pvp.opponents.values().map(|o| o.taken).sum(),
            opponents,
        };

        let mut dummy_skills: Vec<DummySkill> = inner
            .dummy
            .skills
            .iter()
            .map(|(&(skill, dot), totals)| DummySkill {
                skill,
                dot,
                name: ctx.data.skill_name(skill),
                icons: ctx.data.skill_icons(skill),
                totals: *totals,
            })
            .collect();
        dummy_skills.sort_by_key(|s| (std::cmp::Reverse(s.totals.damage), s.skill, s.dot));
        let dummy = DummyView {
            first_ms: inner.dummy.first_ms,
            last_ms: inner.dummy.last_ms,
            totals: inner.dummy.total,
            skills: dummy_skills,
        };

        Snapshot {
            now_ms,
            me,
            in_combat: now_ms - inner.last_combat_ms < COMBAT_LINGER_MS,
            last_combat_ms: inner.last_combat_ms,
            casts,
            party: ctx.party.to_vec(),
            abnormals,
            pvp: pvp_view,
            dummy,
            dungeon,
            map_id: ctx.map_id,
            positions,
        }
    }
}

/// Another character: its skills and fights are not these. The party and
/// the dungeon stay until the next snapshot looks again.
fn switch_to(inner: &mut Inner, me: i32) {
    if inner.me != Some(me) {
        let party = std::mem::take(&mut inner.party);
        *inner = Inner { me: Some(me), party, dungeon: inner.dungeon, ..Inner::default() };
    }
}

fn note_cast(casts: &mut HashMap<i32, Cast>, skill: i32, ms: i64) {
    let key = base_skill(skill);
    let cast = casts.entry(key).or_default();
    if cast.uses > 0 && ms - cast.last_ms < CAST_GAP_MS && ms >= cast.start_ms {
        cast.last_ms = cast.last_ms.max(ms);
        return;
    }
    if cast.uses > 0 {
        let gap = ms - cast.start_ms;
        if (MIN_COOLDOWN_MS..=MAX_COOLDOWN_MS).contains(&gap) {
            cast.min_gap_ms = Some(cast.min_gap_ms.map_or(gap, |m| m.min(gap)));
            cast.last_gap_ms = Some(gap);
        }
    }
    cast.start_ms = ms;
    cast.last_ms = ms;
    cast.uses += 1;
    if casts.len() > MAX_CASTS * 2 {
        let mut by_age: Vec<(i32, i64)> = casts.iter().map(|(k, c)| (*k, c.start_ms)).collect();
        by_age.sort_by_key(|(_, at)| *at);
        for (k, _) in by_age.into_iter().take(casts.len() - MAX_CASTS) {
            casts.remove(&k);
        }
    }
}

fn note_pvp(pvp: &mut Pvp, hit: Hit, me: i32, other: i32) {
    if pvp.session == 0 || hit.ms - pvp.last_ms >= PVP_SESSION_IDLE_MS {
        *pvp = Pvp { session: pvp.session + 1, since_ms: hit.ms, ..Pvp::default() };
    }
    pvp.last_ms = pvp.last_ms.max(hit.ms);
    if !pvp.opponents.contains_key(&other) && pvp.opponents.len() >= MAX_OPPONENTS {
        if let Some(oldest) = pvp.opponents.iter().min_by_key(|(_, o)| o.last_ms).map(|(k, _)| *k) {
            pvp.opponents.remove(&oldest);
        }
    }
    let o = pvp.opponents.entry(other).or_insert_with(|| Opponent { first_ms: hit.ms, ..Opponent::default() });
    o.last_ms = o.last_ms.max(hit.ms);
    let skill = base_skill(hit.skill);
    if hit.actor == me {
        o.dealt += hit.damage;
        o.hits_dealt += 1;
        *o.skills_dealt.entry(skill).or_default() += hit.damage;
        pvp.recent.push_back((hit.ms, hit.damage));
        pvp.recent_sum += hit.damage;
        while pvp.recent.front().is_some_and(|(at, _)| hit.ms - at > BURST_WINDOW_MS) {
            let (_, d) = pvp.recent.pop_front().unwrap_or_default();
            pvp.recent_sum -= d;
        }
        pvp.burst = pvp.burst.max(pvp.recent_sum);
    } else {
        o.taken += hit.damage;
        o.hits_taken += 1;
        *o.skills_taken.entry(skill).or_default() += hit.damage;
        if o.class.is_none() {
            o.class = JobClass::convert_from_skill(hit.skill);
        }
    }
}

/// What `snapshot` reads from the rest of the meter.
pub struct SnapshotContext<'a> {
    pub me: Option<i32>,
    pub data: &'a FeedData,
    pub party: &'a [PartyView],
    /// The buff timeline's live instances.
    pub abnormals: &'a [abnormal::Instance],
    /// The dungeon (instance) id you are in, 0 in the open world.
    pub dungeon_id: i32,
    /// The map you are on, 0 when not known.
    pub map_id: i32,
    /// A monster's NPC code.
    pub mob_code_of: &'a dyn Fn(i32) -> Option<i32>,
    pub name_of: &'a dyn Fn(i32) -> Option<String>,
    pub hp_of: &'a dyn Fn(i32) -> Option<i32>,
    pub dead: &'a dyn Fn(i32) -> bool,
    pub deaths_of_me: &'a dyn Fn(i64) -> u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub now_ms: i64,
    pub me: Option<i32>,
    pub in_combat: bool,
    pub last_combat_ms: i64,
    /// Your skills, most recently cast first.
    pub casts: Vec<CastView>,
    pub party: Vec<PartyView>,
    /// On you and your party.
    pub abnormals: Vec<AbnormalView>,
    pub pvp: PvpView,
    /// Your damage on training dummies since the meter started.
    pub dummy: DummyView,
    /// The dungeon you are in.
    pub dungeon: Option<DungeonView>,
    /// The map you are on (0 when not known yet).
    pub map_id: i32,
    /// Where you, your party and monsters were last seen on it, newest first.
    pub positions: Vec<PositionView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PositionView {
    pub entity: i32,
    /// "me", "party" or "npc".
    pub kind: &'static str,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub ms: i64,
    pub npc: Option<i32>,
    pub name: String,
    pub boss: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DungeonView {
    pub id: i32,
    pub name: String,
    pub difficulty: Option<String>,
    /// When the meter saw you enter (its clock).
    pub entered_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DummyView {
    pub first_ms: i64,
    pub last_ms: i64,
    pub totals: HitTotals,
    pub skills: Vec<DummySkill>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DummySkill {
    pub skill: i32,
    pub dot: bool,
    pub name: String,
    pub icons: Vec<String>,
    #[serde(flatten)]
    pub totals: HitTotals,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CastView {
    pub skill: i32,
    pub name: String,
    pub icons: Vec<String>,
    pub last_cast_ms: i64,
    pub uses: u32,
    pub min_gap_ms: Option<i64>,
    pub last_gap_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PartyView {
    pub id: i32,
    pub name: String,
    pub class_id: Option<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AbnormalView {
    pub entity: i32,
    /// On you.
    pub own: bool,
    pub abnormal: u32,
    pub name: String,
    pub icons: Vec<String>,
    /// The loss of control it is (`control_kind`), if any.
    pub control: Option<&'static str>,
    /// A debuff by its icon (`is_debuff`): not a buff, item or reward.
    pub debuff: bool,
    pub skill: Option<u32>,
    pub caster: i32,
    pub by_me: bool,
    /// You or a party member applied it: not an enemy's debuff.
    pub by_party: bool,
    pub stacks: u32,
    pub start_ms: i64,
    /// On the server's clock; `None` when it never ends.
    pub end_ms: Option<i64>,
    pub endless: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDamage {
    pub skill: i32,
    pub name: String,
    pub damage: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpponentView {
    pub id: i32,
    pub name: String,
    pub class_id: Option<i32>,
    pub hp: Option<i32>,
    pub dead: bool,
    pub killed: bool,
    pub dealt: i64,
    pub taken: i64,
    pub hits_dealt: u32,
    pub hits_taken: u32,
    pub first_ms: i64,
    pub last_ms: i64,
    pub skills_dealt: Vec<SkillDamage>,
    pub skills_taken: Vec<SkillDamage>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PvpView {
    /// Numbered from 1; 0 before the first.
    pub session: u64,
    pub active: bool,
    pub since_ms: i64,
    pub last_ms: i64,
    pub kills: u32,
    pub deaths: u32,
    /// Your most damage on opponents in any `BURST_WINDOW_MS`.
    pub burst: i64,
    pub dealt: i64,
    pub taken: i64,
    pub opponents: Vec<OpponentView>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: i32 = 100;
    const ENEMY: i32 = 200;
    const ALLY: i32 = 300;
    const DUMMY: i32 = 9;

    fn hit(ms: i64, actor: i32, target: i32, skill: i32, damage: i64) -> Hit {
        Hit {
            ms,
            me: Some(ME),
            actor,
            target,
            actor_is_player: actor != 9,
            target_is_player: target != 9,
            skill,
            damage,
            dot: false,
            target_is_dummy: target == DUMMY,
            crit: false,
            back: false,
            perfect: false,
            double: false,
        }
    }

    fn snap(feed: &CombatFeed, now: i64, abnormals: &[abnormal::Instance], party: &[PartyView]) -> Snapshot {
        let data = FeedData::default();
        feed.snapshot(now, &SnapshotContext {
            me: Some(ME),
            data: &data,
            party,
            abnormals,
            dungeon_id: 0,
            map_id: 0,
            mob_code_of: &|_| None,
            name_of: &|_| None,
            hp_of: &|_| None,
            dead: &|id| id == ENEMY && now > 50_000,
            deaths_of_me: &|_| 0,
        })
    }

    #[test]
    fn hits_close_together_are_one_cast_and_the_gap_between_casts_is_the_cooldown() {
        let feed = CombatFeed::default();
        // A three-hit skill, cast again 12 s later, then 10 s after that.
        for ms in [1_000, 1_300, 1_700, 13_000, 13_400, 23_000] {
            feed.note_hit(hit(ms, ME, 9, 11020007, 50));
        }
        let s = snap(&feed, 24_000, &[], &[]);
        let c = &s.casts[0];
        assert_eq!(c.skill, 11020000, "kept under the skill, not its level");
        assert_eq!(c.uses, 3);
        assert_eq!(c.last_cast_ms, 23_000);
        assert_eq!(c.min_gap_ms, Some(10_000));
        assert_eq!(c.last_gap_ms, Some(10_000));
        assert!(s.in_combat);
        assert!(!snap(&feed, 30_000, &[], &[]).in_combat);
    }

    #[test]
    fn a_skill_spammed_faster_than_a_cooldown_learns_none() {
        let feed = CombatFeed::default();
        for ms in [0, 1_500, 3_000] {
            feed.note_cast(Some(ME), 11010000, ms);
        }
        assert_eq!(snap(&feed, 4_000, &[], &[]).casts[0].min_gap_ms, None);
    }

    #[test]
    fn dot_ticks_and_other_players_hits_are_not_your_casts() {
        let feed = CombatFeed::default();
        feed.note_hit(Hit { dot: true, ..hit(0, ME, 9, 11020000, 5) });
        feed.note_hit(hit(0, ALLY, 9, 12020000, 5));
        assert!(snap(&feed, 1_000, &[], &[]).casts.is_empty());
    }

    #[test]
    fn pvp_counts_blows_both_ways_but_not_heals_on_the_party() {
        let feed = CombatFeed::default();
        let ally = [PartyView { id: ALLY, name: "Ally".into(), class_id: None }];
        feed.set_party([ALLY].into());
        feed.note_hit(hit(10_000, ME, ENEMY, 11020000, 1_000));
        feed.note_hit(hit(11_000, ME, ENEMY, 11030000, 2_000));
        feed.note_hit(hit(12_000, ENEMY, ME, 13020000, 700));
        feed.note_hit(hit(12_500, ME, ALLY, 17010000, 900));
        let s = snap(&feed, 13_000, &[], &ally);
        assert_eq!(s.pvp.session, 1);
        assert!(s.pvp.active);
        assert_eq!(s.pvp.opponents.len(), 1, "the ally is not an opponent");
        let o = &s.pvp.opponents[0];
        assert_eq!((o.dealt, o.taken, o.hits_dealt, o.hits_taken), (3_000, 700, 2, 1));
        assert_eq!(o.class_id, Some(13), "their class from their skill");
        assert_eq!(s.pvp.burst, 3_000);
        assert!(!o.killed);
        // They go down: one kill, counted once.
        let s = snap(&feed, 60_000, &[], &ally);
        assert_eq!(s.pvp.kills, 1);
        assert_eq!(snap(&feed, 61_000, &[], &ally).pvp.kills, 1);
        assert!(s.pvp.opponents[0].killed);
        // A minute without a blow ends the session; the next hit starts another.
        assert!(!snap(&feed, 80_000, &[], &ally).pvp.active);
        feed.note_hit(hit(90_000, ENEMY, ME, 13020000, 10));
        let s = snap(&feed, 90_000, &[], &ally);
        assert_eq!((s.pvp.session, s.pvp.kills, s.pvp.taken), (2, 0, 10));
    }

    #[test]
    fn the_burst_is_the_most_damage_in_five_seconds() {
        let feed = CombatFeed::default();
        for (ms, d) in [(0, 100), (1_000, 100), (7_000, 150), (8_000, 150), (9_000, 150)] {
            feed.note_hit(hit(ms, ME, ENEMY, 11020000, d));
        }
        assert_eq!(snap(&feed, 9_500, &[], &[]).pvp.burst, 450);
    }

    fn instance(entity: i32, instance: i32, abnormal: u32, caster: i32, end: Option<i64>) -> abnormal::Instance {
        abnormal::Instance {
            entity,
            instance,
            abnormal,
            caster,
            skill: Some(11020000),
            level: 1,
            endless: end.is_none(),
            start_ms: 1_000 + instance as i64,
            end_ms: None,
            end: abnormal::End::Open,
            server_end_ms: end,
        }
    }

    #[test]
    fn abnormals_on_you_and_your_party_grouped_into_stacks() {
        let feed = CombatFeed::default();
        let party = [PartyView { id: ALLY, name: "Ally".into(), class_id: Some(17) }];
        let live = [
            instance(ME, 1, 500, ME, Some(20_000)),
            instance(ME, 2, 500, ME, Some(25_000)),
            instance(ALLY, 1, 600, 9, Some(20_000)),
            instance(ENEMY, 1, 700, ME, Some(20_000)),
            instance(ME, 3, 800, 9, Some(2_000)),
        ];
        let s = snap(&feed, 5_000, &live, &party);
        assert_eq!(s.abnormals.len(), 2, "not the stranger's, not the one whose timer ran out");
        let mine = &s.abnormals[0];
        assert!(mine.own && mine.by_me && mine.by_party);
        assert_eq!((mine.abnormal, mine.stacks, mine.end_ms), (500, 2, Some(25_000)));
        let theirs = &s.abnormals[1];
        assert!(!theirs.own && !theirs.by_party, "a monster's debuff on the ally");
    }

    #[test]
    fn your_damage_on_a_dummy_adds_up_by_skill_and_kind() {
        let feed = CombatFeed::default();
        feed.note_hit(Hit { crit: true, ..hit(1_000, ME, DUMMY, 11020007, 100) });
        feed.note_hit(Hit { back: true, ..hit(2_000, ME, DUMMY, 11020000, 50) });
        feed.note_hit(Hit { dot: true, ..hit(3_000, ME, DUMMY, 11020000, 10) });
        feed.note_hit(hit(3_000, ALLY, DUMMY, 12020000, 999));
        feed.note_hit(hit(3_000, ME, ENEMY, 11020000, 999));
        let d = snap(&feed, 4_000, &[], &[]).dummy;
        assert_eq!((d.first_ms, d.last_ms), (1_000, 3_000));
        assert_eq!((d.totals.damage, d.totals.hits, d.totals.crit, d.totals.back), (160, 3, 1, 1));
        assert_eq!(d.skills.len(), 2, "the skill's hits, and its ticks apart");
        assert_eq!((d.skills[0].skill, d.skills[0].dot, d.skills[0].totals.damage), (11020000, false, 150));
    }

    #[test]
    fn positions_of_you_and_seen_monsters_on_the_map() {
        let feed = CombatFeed::default();
        feed.note_position(ME, 100.0, 200.0, 5.0, 1_000);
        feed.note_position(ENEMY, 1.0, 2.0, 0.0, 1_000);
        feed.note_position(DUMMY, 300.0, 400.0, 0.0, 1_000);
        let at = |now: i64, map_id: i32| {
            let data = FeedData::default();
            feed.snapshot(now, &SnapshotContext {
                me: Some(ME),
                data: &data,
                party: &[],
                abnormals: &[],
                dungeon_id: 0,
                map_id,
                mob_code_of: &|id| (id == DUMMY).then_some(2400035),
                name_of: &|_| None,
                hp_of: &|_| None,
                dead: &|_| false,
                deaths_of_me: &|_| 0,
            })
            .positions
        };
        // The first look at a map starts it afresh, with what is noted after.
        assert!(at(2_000, 1010).is_empty());
        feed.note_position(ME, 100.0, 200.0, 5.0, 2_000);
        feed.note_position(ENEMY, 1.0, 2.0, 0.0, 2_000);
        feed.note_position(DUMMY, 300.0, 400.0, 0.0, 2_000);
        let p = at(3_000, 1010);
        assert_eq!(p.len(), 2, "you and the monster, not a stranger player");
        assert!(p.iter().any(|x| x.kind == "me" && x.x == 100.0));
        assert!(p.iter().any(|x| x.kind == "npc" && x.npc == Some(2400035)));
        // A monster's goes stale; yours stays a while.
        let p = at(2_000 + NPC_POSITION_MS + 1, 1010);
        assert_eq!(p.iter().map(|x| x.kind).collect::<Vec<_>>(), vec!["me"]);
        // Another map: all gone.
        assert!(at(200_000, 1110).is_empty());
    }

    #[test]
    fn control_kinds_come_from_the_icon() {
        assert_eq!(control_kind("ICON_Abnormal_Stun"), Some("stun"));
        assert_eq!(control_kind("ICON_Abnormal_Knockdown"), Some("knockdown"));
        assert_eq!(control_kind("ICON_Abnormal_HOLD"), Some("root"));
        assert_eq!(control_kind("ICON_Common_Abnormal_Entangle"), Some("root"));
        assert_eq!(control_kind("ICON_Abnormal_CharmingArrow"), None);
        assert_eq!(control_kind("ICON_Abnormal_ImmuneAbnormal"), None);
        assert_eq!(control_kind("ICON_Common_Abnormal_AttackUp"), None);
        // Debuffs are what hurt; rewards, scrolls and buffs are not.
        for icon in ["ICON_Abnormal_DotHp_01", "ICON_Common_Abnormal_DefenseDown", "ICON_Abnormal_HpHealDown",
                     "ICON_Common_Abnormal_Poison2", "ICON_Abnormal_Stun", "ICON_Common_Abnormal_TargetMark"] {
            assert!(is_debuff(icon), "{icon}");
        }
        for icon in ["ICON_Abnormal_RankingReward_Abyss", "Icon_Item_Usable_Scroll_AttackSpeed_A_001", "ICON_Common_Abnormal_AttackUp",
                     "Icon_Item_Usable_Food_Craft_A_r_01", "ICON_Common_Abnormal_HpBarrier", "ICON_SO_SKILL_020",
                     "ICON_Abnormal_Polymorph_01", "ICON_Common_Abnormal_Hot"] {
            assert!(!is_debuff(icon), "{icon}");
        }
    }

    #[test]
    fn the_bundled_tables_load_and_name_a_stun() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/data");
        let data = FeedData::load(&dir, "en");
        assert_eq!(data.abnormal_names.get(&100).map(String::as_str), Some("Stun"));
        assert!(!data.skill_icons.is_empty() && !data.skill_names.is_empty());
        let stuns = data.abnormal_icons.values().filter(|i| control_kind(i) == Some("stun")).count();
        assert!(stuns > 0);
        assert_eq!(data.dungeons.get(&600001).map(|d| d.0.as_str()), Some("Krao Cave"));
    }

    #[test]
    fn the_dungeon_says_when_you_entered_it() {
        let feed = CombatFeed::default();
        let at = |now: i64, dungeon_id: i32| {
            let data = FeedData::default();
            feed.snapshot(now, &SnapshotContext {
                me: Some(ME),
                data: &data,
                party: &[],
                abnormals: &[],
                dungeon_id,
                map_id: 0,
                mob_code_of: &|_| None,
                name_of: &|_| None,
                hp_of: &|_| None,
                dead: &|_| false,
                deaths_of_me: &|_| 0,
            })
            .dungeon
            .map(|d| (d.id, d.entered_ms))
        };
        assert_eq!(at(1_000, 0), None);
        assert_eq!(at(2_000, 600092), Some((600092, 2_000)));
        assert_eq!(at(9_000, 600092), Some((600092, 2_000)), "still the same visit");
        assert_eq!(at(10_000, 0), None);
        assert_eq!(at(11_000, 600092), Some((600092, 11_000)), "entered again");
    }
}
