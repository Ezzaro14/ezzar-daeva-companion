//! The pets aion2pets.net lists, for the Pet Soul Tracker (permission
//! `feed:pets`): a pet newer than the tracker's own data (its pets.js and
//! sources.js, from the game's files) shows up there first. The site allows
//! automated reading (its robots.txt allows every agent).
//!
//! Its pet list is one table, a row per pet:
//!
//! ```text
//! <tr data-g="Cogni" data-r="Verteron" data-n="…">
//! <td><a href="/pets/krall-laborer/">Krall Laborer</a></td><td>…genus badge…</td>
//! <td>Verteron (Elyos)</td><td class="mon">Krall Armed Soldier, Krall Sentinel</td>
//! <td>100%</td></tr>
//! ```
//!
//! `data-g` is the genus, `data-r` the region (`Verteron`, `Altgard`,
//! `Chaotic Lower Reshanta`, or `SoulChest` and `Shop` for pets no monster
//! drops), then the place as the site words it and the monsters, `—` for
//! none. Names only: the site has no game ids, so the tracker matches its
//! pets by English name. Read at most once a day and kept on disk
//! (`pet-catalog.json`), so the site is asked rarely and an offline start
//! still has the last list.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The permission for this list.
pub const PET_CATALOG: &str = "feed:pets";

/// One pet as the site lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SitePet {
    pub name: String,
    pub slug: String,
    /// "Fera", "Cogni", "Natura", "Varian" or "Special".
    pub genus: String,
    /// Where the souls are: a region, or `SoulChest` / `Shop`.
    pub region: String,
    /// The place as the site words it: "Verteron (Elyos)", "Pet Soul Chest: Varian".
    pub place: String,
    pub monsters: Vec<String>,
}

/// The site's list, read from its page. Rows that don't read are left out.
pub fn parse(html: &str) -> Vec<SitePet> {
    let mut out = Vec::new();
    for part in html.split("<tr data-g=\"").skip(1) {
        let row = part.split("</tr>").next().unwrap_or("");
        if let Some(pet) = parse_row(row) {
            out.push(pet);
        }
    }
    out
}

fn parse_row(row: &str) -> Option<SitePet> {
    let genus = row.split('"').next()?.to_string();
    let region = between(row, "data-r=\"", "\"")?.to_string();
    let link = row.split("<a href=\"/pets/").nth(1)?;
    let slug = link.split('/').next()?.to_string();
    let name = unescape(between(link, "\">", "</a>")?).trim().to_string();
    // The cells after the genus badge: the place, then the monsters.
    let after_badge = row.split("</a></td>").nth(2)?;
    let place = unescape(between(after_badge, "<td>", "</td>")?).trim().to_string();
    let monsters = unescape(between(row, "<td class=\"mon\">", "</td>")?);
    let monsters = monsters
        .split(',')
        .map(str::trim)
        .filter(|m| !m.is_empty() && *m != "—" && *m != "-")
        .map(str::to_string)
        .collect();
    let known = ["Fera", "Cogni", "Natura", "Varian", "Special"];
    (!name.is_empty() && !slug.is_empty() && known.contains(&genus.as_str()))
        .then_some(SitePet { name, slug, genus, region, place, monsters })
}

fn between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let rest = &s[s.find(start)? + start.len()..];
    Some(&rest[..rest.find(end)?])
}

/// The few entities the site's text uses.
fn unescape(s: &str) -> String {
    s.replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[cfg(feature = "online")]
mod fetch {
    use super::*;
    use crate::app::AppState;
    use std::time::Duration;
    use tauri::Manager;

    const URL: &str = "https://aion2pets.net/";
    /// How long a list read is good for.
    const KEEP_MS: i64 = 24 * 60 * 60 * 1000;
    /// Fewer rows than this and the page didn't read as the list (the site
    /// changed): the last list stays.
    const MIN_PETS: usize = 50;
    /// More than this is not the site's page.
    const MAX_BYTES: usize = 4 * 1024 * 1024;

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Cached {
        fetched_at: i64,
        pets: Vec<SitePet>,
    }

    fn cache_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
        Some(app.try_state::<AppState>()?.app_data_dir.join("pet-catalog.json"))
    }

    fn read_cache(app: &tauri::AppHandle) -> Option<Cached> {
        serde_json::from_str(&std::fs::read_to_string(cache_file(app)?).ok()?).ok()
    }

    async fn download(app: &tauri::AppHandle) -> Result<Vec<SitePet>, String> {
        let http = app.try_state::<AppState>().ok_or("no app state")?.http.clone();
        let res = http.get(URL).timeout(Duration::from_secs(20)).send().await.map_err(|e| format!("Could not reach aion2pets.net: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("aion2pets.net answered {}", res.status()));
        }
        let bytes = res.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err("aion2pets.net sent more than a pet list".into());
        }
        let pets = parse(&String::from_utf8_lossy(&bytes));
        if pets.len() < MIN_PETS {
            return Err(format!("aion2pets.net's page did not read as its pet list ({} pets)", pets.len()));
        }
        Ok(pets)
    }

    /// The list: the one kept if less than a day old, else the site's now
    /// (kept for next time), else the one kept, however old.
    pub async fn catalog(app: &tauri::AppHandle) -> Result<Value, String> {
        let now = crate::clock::now_ms();
        let cached = read_cache(app);
        if let Some(c) = cached.as_ref().filter(|c| now - c.fetched_at < KEEP_MS) {
            return Ok(serde_json::json!({ "fetchedAt": c.fetched_at, "pets": c.pets }));
        }
        match download(app).await {
            Ok(pets) => {
                tracing::info!("Pet catalog: {} pets from aion2pets.net", pets.len());
                let fresh = Cached { fetched_at: now, pets };
                if let (Some(path), Ok(json)) = (cache_file(app), serde_json::to_string(&fresh)) {
                    let _ = crate::atomic_file::write(&path, json.as_bytes());
                }
                Ok(serde_json::json!({ "fetchedAt": fresh.fetched_at, "pets": fresh.pets }))
            }
            Err(e) => {
                tracing::info!("Pet catalog: {e}");
                match cached {
                    Some(c) => Ok(serde_json::json!({ "fetchedAt": c.fetched_at, "pets": c.pets, "stale": true })),
                    None => Err(e),
                }
            }
        }
    }
}

/// The pets aion2pets.net lists: `{ fetchedAt, pets: [{ name, slug, genus,
/// region, place, monsters }], stale? }`, at most a day old unless the site
/// can't be reached (`stale`).
#[tauri::command]
pub async fn plugin_pet_catalog(app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: Option<String>) -> Result<Value, String> {
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, PET_CATALOG)?;
    #[cfg(feature = "online")]
    {
        fetch::catalog(&app).await
    }
    #[cfg(not(feature = "online"))]
    {
        let _ = app;
        Err("this build has no network features".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rows as aion2pets.net served them on 2026-11-14.
    const PAGE: &str = concat!(
        "<table id=\"pets\" class=\"list\"><thead><tr><th>Pet</th><th>Genus</th><th>Where</th><th>Monster that drops souls</th><th>Transform size</th></tr></thead>\n<tbody>",
        "<tr data-g=\"Cogni\" data-r=\"Verteron\" data-n=\"krall laborer krall armed soldier krall sentinel mutated krall laborer\">\n",
        "<td><a href=\"/pets/krall-laborer/\">Krall Laborer</a></td><td><a class=\"badge\" style=\"--c:#3f9be0\" href=\"/genus/cogni/\">🛡️ Cogni</a></td>\n",
        "<td>Verteron (Elyos)</td><td class=\"mon\">Krall Armed Soldier, Krall Sentinel, Mutated Krall Laborer</td>\n<td>100%</td></tr>",
        "<tr data-g=\"Varian\" data-r=\"SoulChest\" data-n=\"krao mutant \">\n",
        "<td><a href=\"/pets/krao-mutant/\">Krao Mutant</a></td><td><a class=\"badge\" style=\"--c:#9a6cf0\" href=\"/genus/varian/\">🧪 Varian</a></td>\n",
        "<td>Pet Soul Chest: Varian</td><td class=\"mon\">—</td>\n<td>90%</td></tr>",
        "<tr data-g=\"Cogni\" data-r=\"SoulChest\" data-n=\"sentinel k'nash \">\n",
        "<td><a href=\"/pets/sentinel-knash/\">Sentinel K'nash</a></td><td><a class=\"badge\" style=\"--c:#3f9be0\" href=\"/genus/cogni/\">🛡️ Cogni</a></td>\n",
        "<td>Pet Soul Chest: Cogni</td><td class=\"mon\">—</td>\n<td>80%</td></tr>",
        "<tr data-g=\"Nonsense\" data-r=\"X\"><td>not a pet</td></tr>",
        "</tbody></table>",
    );

    #[test]
    fn the_sites_rows_read_as_pets() {
        let pets = parse(PAGE);
        assert_eq!(pets.len(), 3, "{pets:?}");
        assert_eq!(
            pets[0],
            SitePet {
                name: "Krall Laborer".into(),
                slug: "krall-laborer".into(),
                genus: "Cogni".into(),
                region: "Verteron".into(),
                place: "Verteron (Elyos)".into(),
                monsters: vec!["Krall Armed Soldier".into(), "Krall Sentinel".into(), "Mutated Krall Laborer".into()],
            }
        );
        assert_eq!((pets[1].region.as_str(), pets[1].place.as_str()), ("SoulChest", "Pet Soul Chest: Varian"));
        assert!(pets[1].monsters.is_empty());
        assert_eq!(pets[2].name, "Sentinel K'nash");
        assert_eq!(unescape("Sentinel K&#39;nash &amp; co"), "Sentinel K'nash & co");
    }
}
