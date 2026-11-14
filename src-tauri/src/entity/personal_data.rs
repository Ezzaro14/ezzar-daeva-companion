use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::analyzed_skill::AnalyzedSkill;
use super::damage_packet::ParsedDamagePacket;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalData {
    pub job: String,
    pub dps: f64,
    pub amount: f64,
    pub damage_contribution: f64,
    #[serde(skip)]
    pub analyzed_data: HashMap<i32, AnalyzedSkill>,
    pub nickname: String,
    /// Combat power from the party roster packet, or 0 when this player isn't in
    /// your party (the roster is the only source, so non-party players have none).
    pub combat_power: i64,
    /// Gear score from the same roster packet; 0 when unknown, as above.
    #[serde(default)]
    pub gear_score: i32,
    /// The Others row on an open-world boss: everyone not in your party,
    /// from the HP the boss lost (`DpsCalculator::world_boss_rows`).
    #[serde(default)]
    pub is_others: bool,
    /// On your party's roster (or you): what the meter's "My party" shows.
    #[serde(default)]
    pub in_party: bool,
    #[serde(default)]
    pub hps: f64,
    #[serde(default)]
    pub heal_amount: f64,
    /// Times this player died in the fight the meter shows (or just after its
    /// last hit: a wipe), from the HP records (`DataStorage::deaths_between`).
    #[serde(default)]
    pub deaths: u32,
}

impl PersonalData {
    pub fn new(nickname: String) -> Self {
        Self {
            job: String::new(),
            dps: 0.0,
            amount: 0.0,
            damage_contribution: 0.0,
            analyzed_data: HashMap::new(),
            nickname,
            combat_power: 0,
            gear_score: 0,
            is_others: false,
            in_party: false,
            hps: 0.0,
            heal_amount: 0.0,
            deaths: 0,
        }
    }

    pub fn with_job(nickname: String, job: String) -> Self {
        Self {
            job,
            dps: 0.0,
            amount: 0.0,
            damage_contribution: 0.0,
            analyzed_data: HashMap::new(),
            nickname,
            combat_power: 0,
            gear_score: 0,
            is_others: false,
            in_party: false,
            hps: 0.0,
            heal_amount: 0.0,
            deaths: 0,
        }
    }

    pub fn process_pdp(&mut self, pdp: &ParsedDamagePacket, skill_name: &str) {
        self.amount += pdp.total_damage() as f64;
        let skill_code = pdp.skill_code();
        let skill = self.analyzed_data.entry(skill_code).or_insert_with(|| {
            AnalyzedSkill::new(skill_code, skill_name.to_string())
        });
        skill.process_pdp(pdp);
    }

    pub fn merge_from(&mut self, other: &PersonalData) {
        self.amount += other.amount;
        self.heal_amount += other.heal_amount;
        for (skill_code, other_skill) in &other.analyzed_data {
            let existing = self.analyzed_data.entry(*skill_code).or_insert_with(|| {
                AnalyzedSkill::new(*skill_code, other_skill.skill_name.clone())
            });
            existing.merge_from(other_skill);
        }
    }
}
