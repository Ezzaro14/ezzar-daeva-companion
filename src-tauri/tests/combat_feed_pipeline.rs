//! The combat feed (combat/combat_feed.rs) fed the way the meter feeds it:
//! game records through `StreamProcessor::consume_stream`, as captured, and
//! read back with the snapshot the bundled plugins get.

use std::sync::Arc;

use a2tools_dps_meter_lib::capture::stream_processor::StreamProcessor;
use a2tools_dps_meter_lib::combat::combat_feed::{base_skill, FeedData, Snapshot, SnapshotContext};
use a2tools_dps_meter_lib::combat::data_storage::DataStorage;
use a2tools_dps_meter_lib::i18n::lookup::{NpcLookup, SkillLookup};

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

/// A `04 38` damage record (body as in stream_processor's tests), framed as
/// on the wire: the length counts the payload plus 4 (capture::framing).
fn damage_frame(body: &str) -> Vec<u8> {
    let mut packet = vec![0x00, 0x04, 0x38];
    packet.extend(hex(body));
    packet[0] = (packet.len() + 3) as u8;
    packet
}

/// One hit of 976 (layout 6, switch 0x16), from stream_processor's tests.
const HIT: &str = "b1ea011600f30a40c0f40063028000010b199b5f01000000ac52d007";
/// Spirit's Benediction added by 6759 on itself, from abnormal.rs's tests.
const BENEDICTION_ON: &str = "342a38e73401138202e165a6091027000000000000bc5cba14a1010000e73403300af7000047e44c47b46a22c700e85a46";

fn processor(ms: i64) -> (Arc<DataStorage>, StreamProcessor) {
    let storage = Arc::new(DataStorage::new());
    let mut p = StreamProcessor::new(storage.clone(), Arc::new(SkillLookup::new()), Arc::new(NpcLookup::new()));
    p.set_override_timestamp(Some(ms));
    (storage, p)
}

fn snapshot(storage: &DataStorage, now: i64) -> Snapshot {
    let data = FeedData::load(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/data"), "en");
    let me = storage.local_player_id().map(|id| id as i32);
    let abnormals = storage.live_abnormals();
    storage.combat_feed().snapshot(now, &SnapshotContext {
        me,
        data: &data,
        party: &[],
        abnormals: &abnormals,
        dungeon_id: storage.current_dungeon_id(),
        map_id: storage.current_map(),
        mob_code_of: &|id| storage.mob_code(id),
        name_of: &|id| storage.get_nickname(id),
        hp_of: &|id| storage.last_hp(id),
        dead: &|id| storage.is_entity_dead(id),
        deaths_of_me: &|_| 0,
    })
}

/// Who hit whom in `HIT`, as the parser reads it.
fn actors_of_hit() -> (i32, i32, i32) {
    let (storage, mut p) = processor(1_000);
    p.consume_stream(&damage_frame(HIT));
    let combat = storage.get_combat_snapshot();
    let (target, data) = combat.iter().next().expect("the hit is read");
    let (actor, a) = data.actors.iter().next().unwrap();
    let skill = a.skills.keys().next().unwrap().0;
    (*actor, *target, skill)
}

#[test]
fn your_hits_are_casts_and_their_gap_is_the_cooldown() {
    let (actor, _, skill) = actors_of_hit();
    let (storage, mut p) = processor(1_000);
    storage.set_local_player_id(Some(actor as i64));
    p.consume_stream(&damage_frame(HIT));
    p.set_override_timestamp(Some(13_000));
    p.consume_stream(&damage_frame(HIT));
    let s = snapshot(&storage, 14_000);
    let cast = s.casts.iter().find(|c| c.skill == base_skill(skill)).expect("the skill is a cast of yours");
    assert_eq!((cast.uses, cast.last_cast_ms, cast.min_gap_ms), (2, 13_000, Some(12_000)));
    assert!(s.in_combat);
}

#[test]
fn someone_elses_hits_are_not_your_casts() {
    let (actor, _, _) = actors_of_hit();
    let (storage, mut p) = processor(1_000);
    storage.set_local_player_id(Some(actor as i64 + 1));
    p.consume_stream(&damage_frame(HIT));
    assert!(snapshot(&storage, 2_000).casts.is_empty());
}

#[test]
fn your_hits_on_a_dummy_add_up() {
    let (actor, target, skill) = actors_of_hit();
    let (storage, mut p) = processor(1_000);
    storage.set_local_player_id(Some(actor as i64));
    storage.register_training_dummy(target);
    p.consume_stream(&damage_frame(HIT));
    p.set_override_timestamp(Some(2_000));
    p.consume_stream(&damage_frame(HIT));
    let d = snapshot(&storage, 3_000).dummy;
    assert_eq!((d.totals.damage, d.totals.hits, d.first_ms, d.last_ms), (1_952, 2, 1_000, 2_000));
    assert_eq!(d.skills[0].skill, base_skill(skill));
}

#[test]
fn a_buff_you_apply_is_live_on_you_and_a_cast_of_its_skill() {
    let (storage, mut p) = processor(1_000);
    storage.set_local_player_id(Some(6759));
    p.consume_stream(&hex(BENEDICTION_ON));
    let s = snapshot(&storage, 2_000);
    let buff = s.abnormals.iter().find(|a| a.abnormal == 161_900_001).expect("the buff is live");
    assert!(buff.own && buff.by_me && buff.by_party);
    assert_eq!((buff.stacks, buff.end_ms), (1, Some(1_791_349_120_188)));
    assert!(!buff.name.is_empty(), "named from the bundled tables");
    assert!(s.casts.iter().any(|c| c.skill == 16_190_000), "applying it was a cast of Spirit's Benediction");
    // The record ends with the caster's position: you, where you cast it.
    let me = s.positions.iter().find(|p| p.kind == "me").expect("your position");
    assert!(me.x.abs() > 1.0 && me.x.abs() < 1e6 && me.y.abs() < 1e6, "a position in the world: {me:?}");
}
