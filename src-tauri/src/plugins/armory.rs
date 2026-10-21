//! Characters as the official site shows them (aion2.plaync.com): profile,
//! stats, Daevanion boards node by node, equipment, skills, pet and wings,
//! for the Progression Guide. And the players to compare you with: the top
//! of your class on a2tools.app's leaderboard for your region, and the
//! players this session has seen in your fights.
//!
//! The site's own pages read the same public endpoints:
//!
//! ```text
//! api-search.plaync.com/aion2global/search/v2/character?keyword&region&localeInfo[&serverId]
//! aion2.plaync.com/api/character/info?characterId&serverId&region&lang
//! aion2.plaync.com/api/character/equipment?…
//! aion2.plaync.com/api/character/daevanion/detail?…&boardId
//! ```
//!
//! Every character read is kept on disk (`armory/`) for a day, and requests
//! go one at a time, a few a second, so a pool of thirty players is read
//! once and then served from the cache.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use tauri::Manager;

use crate::app::AppState;

/// The permission for these calls.
pub const ARMORY: &str = "feed:armory";
const SEARCH: &str = "https://api-search.plaync.com/aion2global/search/v2/character";
const SITE: &str = "https://aion2.plaync.com/api/character";
const LEADERBOARD: &str = "https://a2tools.app/leaderboard";
/// How long a character read is good for.
const KEEP_SECS: i64 = 24 * 3600;
/// Your own, when not asked to read it again.
const KEEP_OWN_SECS: i64 = 10 * 60;
/// Between two requests to the site.
const PACE: Duration = Duration::from_millis(350);
/// Players read for a pool, at most.
const MAX_POOL: usize = 24;
/// A leaderboard name's characters this many levels below the highest of
/// that name are not the one on the leaderboard.
const LEVEL_SLACK: i64 = 5;

/// A server's region on the official site, by the second digit of its id.
pub fn region_of(server: u16) -> Option<&'static str> {
    match (server / 100) % 10 {
        1 => Some("nae"),
        2 => Some("naw"),
        3 => Some("eu"),
        4 => Some("la"),
        5 => Some("as"),
        _ => None,
    }
}

/// The site's class name for a class id (`JobClass::class_prefix`).
pub fn class_name(id: i32) -> Option<&'static str> {
    Some(match id {
        11 => "Gladiator",
        12 => "Templar",
        13 => "Assassin",
        14 => "Ranger",
        15 => "Sorcerer",
        16 => "Spiritmaster",
        17 => "Cleric",
        18 => "Chanter",
        19 => "Brawler",
        _ => return None,
    })
}

/// Whether the site's `className` is class `id` (Spiritmaster is also called
/// Elementalist, Brawler Fighter).
fn is_class(site: &str, id: i32) -> bool {
    let site = site.to_ascii_lowercase();
    let aliases: &[&str] = match id {
        16 => &["spiritmaster", "elementalist"],
        19 => &["brawler", "fighter"],
        _ => &[],
    };
    class_name(id).is_some_and(|n| n.to_ascii_lowercase() == site) || aliases.contains(&site.as_str())
}

/// A search hit, its name's highlight taken off.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub id: String,
    pub name: String,
    pub server: u16,
    pub level: i64,
    /// The site's class-and-look id (one class has several).
    pub pc_id: i64,
}

pub fn parse_hits(v: &Value) -> Vec<Hit> {
    v["list"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|h| {
            let name = h["name"].as_str()?.replace("<strong>", "").replace("</strong>", "");
            let id = percent_decode(h["characterId"].as_str()?);
            Some(Hit {
                id,
                name,
                server: u16::try_from(h["serverId"].as_u64()?).ok()?,
                level: h["level"].as_i64().unwrap_or(0),
                pc_id: h["pcId"].as_i64().unwrap_or(0),
            })
        })
        .collect()
}

fn percent_decode(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(x) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(x);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The names on a2tools.app's leaderboard page, in order, without repeats.
pub fn parse_leaderboard(html: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for part in html.split("href=\"/players/").skip(1) {
        let Some(path) = part.split('"').next() else { continue };
        let Some((_, name)) = path.split_once('/') else { continue };
        let name = percent_decode(name);
        if !name.is_empty() && seen.insert(name.clone()) {
            out.push(name);
        }
    }
    out
}

/// a2tools.app's name for an official region.
fn leaderboard_region(region: &str) -> &str {
    if region == "la" { "sa" } else { region }
}

struct Client {
    http: reqwest::Client,
    dir: PathBuf,
}

impl Client {
    fn new(app: &tauri::AppHandle) -> Result<Client, String> {
        let state = app.try_state::<AppState>().ok_or("no app state")?;
        let dir = state.app_data_dir.join("armory");
        let _ = std::fs::create_dir_all(&dir);
        Ok(Client { http: state.http.clone(), dir })
    }

    async fn get(&self, url: &str, query: &[(&str, &str)]) -> Result<Value, String> {
        tokio::time::sleep(PACE).await;
        let response = self
            .http
            .get(url)
            .query(query)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("Could not reach the official site: {e}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("The official site answered {status}"));
        }
        serde_json::from_str(&text).map_err(|e| format!("The official site's answer did not read: {e}"))
    }

    async fn search(&self, name: &str, region: &str, server: Option<u16>) -> Result<Vec<Hit>, String> {
        let server = server.map(|s| s.to_string());
        let mut q = vec![("keyword", name), ("region", region), ("localeInfo", "en-us"), ("size", "20")];
        if let Some(s) = server.as_deref() {
            q.push(("serverId", s));
        }
        Ok(parse_hits(&self.get(SEARCH, &q).await?).into_iter().filter(|h| h.name == name).collect())
    }

    fn cache_file(&self, server: u16, id: &str) -> PathBuf {
        let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        self.dir.join(format!("{server}-{safe}.json"))
    }

    fn cached(&self, server: u16, id: &str, max_age: i64) -> Option<Value> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(self.cache_file(server, id)).ok()?).ok()?;
        let age = crate::clock::now_ms() / 1000 - v["fetchedAt"].as_i64()?;
        (age < max_age).then_some(v)
    }

    /// The class each `pcId` seen so far stands for (several per class, by
    /// race and gender, with no table to read them from): a search hit of
    /// another class is passed over unread.
    fn pc_classes(&self) -> std::collections::HashMap<i64, String> {
        std::fs::read_to_string(self.dir.join("pcids.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    fn note_pc_class(&self, pc_id: i64, class: &str) {
        let mut known = self.pc_classes();
        if pc_id > 0 && known.get(&pc_id).map(String::as_str) != Some(class) {
            known.insert(pc_id, class.to_string());
            let _ = std::fs::write(self.dir.join("pcids.json"), serde_json::to_string(&known).unwrap_or_default());
        }
    }

    /// Whether a hit can be of class `class`: not when its pcId is known as another's.
    fn may_be(&self, hit: &Hit, class: i32) -> bool {
        self.pc_classes().get(&hit.pc_id).is_none_or(|c| is_class(c, class))
    }

    /// One character: info and equipment, and with `boards` every open
    /// board's nodes too (read later, for the players compared only); with
    /// `want`, only when it is of that class (else just its info is read).
    async fn character(&self, id: &str, server: u16, max_age: i64, boards: bool) -> Result<Value, String> {
        self.character_of(id, server, max_age, None, boards).await
    }

    async fn character_of(&self, id: &str, server: u16, max_age: i64, want: Option<i32>, boards: bool) -> Result<Value, String> {
        let region = region_of(server).ok_or("a server outside the Global regions")?;
        let server_s = server.to_string();
        let q = [("characterId", id), ("serverId", server_s.as_str()), ("region", region), ("lang", "en")];
        let mut v = match self.cached(server, id, max_age) {
            Some(v) => v,
            None => {
                let info = self.get(&format!("{SITE}/info"), &q).await?;
                let class = info["profile"]["className"].as_str().unwrap_or_default().to_string();
                self.note_pc_class(info["profile"]["pcId"].as_i64().unwrap_or(0), &class);
                if let Some(want) = want
                    && !is_class(&class, want)
                {
                    return Err(format!("{class}, not {}", class_name(want).unwrap_or("the class")));
                }
                let equipment = self.get(&format!("{SITE}/equipment"), &q).await?;
                let v = serde_json::json!({
                    "fetchedAt": crate::clock::now_ms() / 1000,
                    "boardsRead": false,
                    "profile": info["profile"],
                    "stat": info["stat"],
                    "title": info["title"],
                    "daevanion": { "boardList": info["daevanion"]["boardList"], "boards": {} },
                    "equipment": equipment["equipment"],
                    "skill": equipment["skill"],
                    "petwing": equipment["petwing"],
                });
                let _ = std::fs::write(self.cache_file(server, id), v.to_string());
                v
            }
        };
        if let Some(want) = want
            && !v["profile"]["className"].as_str().is_some_and(|c| is_class(c, want))
        {
            return Err("another class".into());
        }
        if boards && v["boardsRead"].as_bool() != Some(true) {
            let mut read = serde_json::Map::new();
            for board in v["daevanion"]["boardList"].as_array().cloned().unwrap_or_default() {
                if board["open"].as_i64() != Some(1) {
                    continue;
                }
                let Some(board_id) = board["id"].as_i64() else { continue };
                let board_s = board_id.to_string();
                let mut bq = q.to_vec();
                bq.push(("boardId", board_s.as_str()));
                if let Ok(detail) = self.get(&format!("{SITE}/daevanion/detail"), &bq).await {
                    read.insert(board_s.clone(), detail);
                }
            }
            v["daevanion"]["boards"] = Value::Object(read);
            v["boardsRead"] = Value::Bool(true);
            let _ = std::fs::write(self.cache_file(server, id), v.to_string());
        }
        Ok(v)
    }

    /// A character by name and server.
    async fn by_name(&self, name: &str, server: u16, max_age: i64, boards: bool) -> Result<Value, String> {
        let region = region_of(server).ok_or("a server outside the Global regions")?;
        let hit = self
            .search(name, region, Some(server))
            .await?
            .into_iter()
            .find(|h| h.server == server)
            .ok_or_else(|| format!("{name} was not found on the official site"))?;
        self.character(&hit.id, server, max_age, boards).await
    }

    /// The leaderboard's top names for a class in a region.
    async fn leaderboard(&self, class: i32, region: &str) -> Result<Vec<String>, String> {
        tokio::time::sleep(PACE).await;
        let html = self
            .http
            .get(LEADERBOARD)
            .query(&[("board", "dps"), ("cls", &class.to_string()), ("region", leaderboard_region(region))])
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("Could not reach a2tools.app: {e}"))?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        Ok(parse_leaderboard(&html))
    }
}

fn emit(app: &tauri::AppHandle, plugin: &str, event: &str, data: Value) {
    let msg = serde_json::json!({ "plugin": plugin, "event": event, "data": data });
    let _ = super::emit_plugin(app, plugin, msg);
}

/// You (or a character by name and server), as the official site shows it.
#[tauri::command]
pub async fn plugin_armory_character(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: Option<String>,
    server: Option<u16>,
    refresh: Option<bool>,
    plugin: Option<String>,
) -> Result<Value, String> {
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, ARMORY)?;
    let (name, server, own) = match (name, server) {
        (Some(n), Some(s)) => (n, s, false),
        _ => {
            let state = app.try_state::<AppState>().ok_or("no app state")?;
            let p = state.data_storage.local_profile();
            let name = p.name.ok_or("Log in to a character first: the app reads who you are from the game.")?;
            if p.server_id == 0 {
                return Err("Your server isn't known yet: change zone or open your character sheet in game.".into());
            }
            (name, p.server_id, true)
        }
    };
    let max_age = if refresh.unwrap_or(false) { 0 } else if own { KEEP_OWN_SECS } else { KEEP_SECS };
    Client::new(&app)?.by_name(&name, server, max_age, true).await
}

/// The players to compare a class with: the leaderboard's top of the class in
/// the region, the players seen this session, and `extra` ({name, server});
/// read in the background, each as it arrives sent as "armory-player", and
/// "armory-pool" with the progress.
#[tauri::command]
pub async fn plugin_armory_pool(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    class: i32,
    server: u16,
    extra: Option<Vec<Value>>,
    plugin: Option<String>,
) -> Result<(), String> {
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, ARMORY)?;
    let region = region_of(server).ok_or("a server outside the Global regions")?.to_string();
    let client = Client::new(&app)?;
    let state = app.try_state::<AppState>().ok_or("no app state")?;
    let me = state.data_storage.local_profile().name;
    let seen: Vec<(String, u16)> = state
        .data_storage
        .seen_players()
        .into_iter()
        .filter(|(n, s, c)| region_of(*s) == Some(region.as_str()) && c.is_none_or(|c| c.class_prefix() == class) && Some(n) != me.as_ref())
        .map(|(n, s, _)| (n, s))
        .collect();
    let extra: Vec<(String, u16)> = extra
        .unwrap_or_default()
        .iter()
        .filter_map(|v| Some((v["name"].as_str()?.to_string(), u16::try_from(v["server"].as_u64()?).ok()?)))
        .collect();
    tauri::async_runtime::spawn(async move {
        let mut found = 0usize;
        let mut failed = 0usize;
        let tell = |stage: &str, found: usize, failed: usize, total: usize, note: Option<String>| {
            emit(&app, &id, "armory-pool", serde_json::json!({ "stage": stage, "found": found, "failed": failed, "total": total, "note": note }));
        };
        let leaders = match client.leaderboard(class, &region).await {
            Ok(names) => names,
            Err(e) => {
                tell("leaderboard", 0, 0, 0, Some(e));
                Vec::new()
            }
        };
        // Named players first (yours to compare with), then the leaderboard, then those seen.
        let mut queue: Vec<(String, Option<u16>, &str)> = extra.into_iter().map(|(n, s)| (n, Some(s), "added")).collect();
        queue.extend(leaders.into_iter().map(|n| (n, None, "leaderboard")));
        queue.extend(seen.into_iter().map(|(n, s)| (n, Some(s), "seen")));
        let mut done = HashSet::new();
        queue.retain(|(n, _, _)| done.insert(n.clone()) && Some(n) != me.as_ref());
        queue.truncate(MAX_POOL);
        let total = queue.len();
        tell("reading", 0, 0, total, None);
        // First everyone's profile and gear; then the boards of those compared.
        let mut read: Vec<(i64, String, u16, &str)> = Vec::new();
        for (name, server, source) in queue {
            let result = match server {
                Some(s) => client.by_name(&name, s, KEEP_SECS, false).await,
                // From the leaderboard: the region's character of that name and
                // class, the highest level first.
                None => async {
                    let mut hits = client.search(&name, &region, None).await?;
                    hits.sort_by_key(|h| std::cmp::Reverse(h.level));
                    let top = hits.first().map_or(0, |h| h.level);
                    for hit in hits.into_iter().filter(|h| h.level + LEVEL_SLACK >= top) {
                        if !client.may_be(&hit, class) {
                            continue;
                        }
                        if let Ok(c) = client.character_of(&hit.id, hit.server, KEEP_SECS, Some(class), false).await {
                            return Ok(c);
                        }
                    }
                    Err(format!("no {} named {name} in the region", class_name(class).unwrap_or("player")))
                }
                .await,
            };
            match result {
                Ok(c) if source == "added" || c["profile"]["className"].as_str().is_some_and(|n| is_class(n, class)) => {
                    found += 1;
                    let cp = c["profile"]["combatPower"].as_i64().unwrap_or(0);
                    if let (Some(cid), Some(s)) = (c["profile"]["characterId"].as_str(), c["profile"]["serverId"].as_u64()) {
                        read.push((cp, cid.to_string(), s as u16, source));
                    }
                    emit(&app, &id, "armory-player", serde_json::json!({ "source": source, "character": c }));
                }
                Ok(_) => {}
                Err(_) => failed += 1,
            }
            tell("reading", found, failed, total, None);
        }
        read.sort_by_key(|r| std::cmp::Reverse(r.0));
        let compared = read.len().div_ceil(2).max(5).min(read.len());
        for (i, (_, cid, s, source)) in read.into_iter().take(compared).enumerate() {
            if let Ok(c) = client.character(&cid, s, KEEP_SECS, true).await {
                emit(&app, &id, "armory-player", serde_json::json!({ "source": source, "character": c }));
            }
            tell("boards", i + 1, failed, compared, None);
        }
        tell("done", found, failed, total, None);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn servers_name_their_region_by_the_second_digit() {
        assert_eq!(region_of(2201), Some("naw"));
        assert_eq!(region_of(1304), Some("eu"));
        assert_eq!(region_of(1102), Some("nae"));
        assert_eq!(region_of(2501), Some("as"));
        assert_eq!(region_of(1002), None, "Korea");
    }

    #[test]
    fn search_hits_lose_their_highlight_and_escapes() {
        let v = serde_json::json!({ "list": [
            { "characterId": "9PO8eUjDa8pGlEbVzGrXcGoM4WtQFNnGvDiJQIzEtEE%3D", "name": "<strong>RavenN</strong>", "serverId": 2201, "level": 45 },
            { "characterId": "abc", "name": "<strong>Ravenn</strong>e", "serverId": 2201, "level": 45 },
        ]});
        let hits = parse_hits(&v);
        assert_eq!(
            hits[0],
            Hit { id: "9PO8eUjDa8pGlEbVzGrXcGoM4WtQFNnGvDiJQIzEtEE=".into(), name: "RavenN".into(), server: 2201, level: 45, pc_id: 0 }
        );
        assert_eq!(hits[1].name, "Ravenne");
    }

    #[test]
    fn the_leaderboard_names_its_players_once_each() {
        let html = r#"<a href="/players/nae/%E7%99%BD%E9%85%92" title="x"></a><a href="/players/nae/Bob">
            <a href="/players/nae/%E7%99%BD%E9%85%92"></a><a href="/logs/1"></a>"#;
        assert_eq!(parse_leaderboard(html), vec!["白酒".to_string(), "Bob".to_string()]);
        assert_eq!(leaderboard_region("la"), "sa");
    }

    #[test]
    fn class_names_match_the_sites() {
        assert!(is_class("Sorcerer", 15));
        assert!(is_class("Elementalist", 16) && is_class("Spiritmaster", 16));
        assert!(!is_class("Cleric", 15));
    }
}
