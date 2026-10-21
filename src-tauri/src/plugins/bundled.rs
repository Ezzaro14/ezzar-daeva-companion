//! Plugins that ship with the meter, and the feed only they are given.
//!
//! Fork addition. The bundled plugins live in `bundled-plugins/` (a resource
//! of the build) and load like reviewed ones: one installed from the
//! catalog under the same id wins, so a newer upstream version replaces the
//! bundled copy. Kept in this file, with a few calls from `mod.rs`, so
//! upstream changes to the plugin host merge cleanly.
//!
//! The `feed:combat` permission gives a plugin what the bundled overlays are
//! made of (`combat::combat_feed`):
//!
//! - `a2.on("combat", snapshot)`: your casts, the buffs and debuffs on you
//!   and your party, PvP. About four times a second while something changes,
//!   at least once a second.
//! - `a2.on("fight", fight)`: a fight the meter saved to History, with your
//!   numbers and skills and your party's totals. A boss fight is saved again
//!   every 30 s while it lasts, so the same `id` comes more than once; the
//!   last is the whole fight.
//!
//! A bundled plugin may also show the game's own icons, from its CDN (images
//! only), as the meter does.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::Manager;

use crate::app::AppState;
use crate::combat::combat_feed::{FeedData, PartyView, Snapshot, SnapshotContext};
use crate::entity::fight_record::FightRecord;

use super::PluginHost;

/// The permission for the combat feed.
pub const COMBAT_FEED: &str = "feed:combat";
/// How often the combat snapshot is looked at.
pub const TICK: Duration = Duration::from_millis(250);
/// The snapshot goes out at least this often, changed or not, for timers.
const RESEND: Duration = Duration::from_secs(1);
/// The image sources a bundled plugin may use besides its own files: the
/// game's icons, and characters' portraits (the Progression Guide; the
/// portrait address sends on to fizz-download).
pub const ICON_CDN: &str = "https://assets.playnccdn.com https://profileimg.plaync.com https://fizz-download.playnccdn.com";
/// Saved fights waiting to go to plugins.
const MAX_SAVED: usize = 16;

/// The folders of the plugins this build ships: each folder under
/// `bundled-plugins` in the resources (an installed build) or beside the
/// crate (a development build). A build run from a cargo target folder (one
/// with cargo's `.fingerprint` beside it, wherever the target folder is)
/// reads the crate's folder: the copy the build put beside it is only as new
/// as the last build, and the plugins' files change without one.
pub fn dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let in_tree = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join(".fingerprint").is_dir()))
        .unwrap_or(false);
    let mut roots = Vec::new();
    if in_tree {
        roots.push(crate_dir.join("bundled-plugins"));
    }
    if let Ok(res) = app.path().resource_dir() {
        roots.push(res.join("bundled-plugins"));
    }
    roots.push(crate_dir.join("bundled-plugins"));
    let Some(root) = roots.into_iter().find(|r| r.is_dir()) else { return Vec::new() };
    let mut out: Vec<PathBuf> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join("manifest.json").is_file())
        .collect();
    out.sort();
    out
}

fn saved_fights() -> &'static Mutex<VecDeque<FightRecord>> {
    static SAVED: std::sync::OnceLock<Mutex<VecDeque<FightRecord>>> = std::sync::OnceLock::new();
    SAVED.get_or_init(Default::default)
}

/// A fight History saved (`FightHistoryManager::save_fight`), to pass on.
pub fn fight_saved(record: &FightRecord) {
    let mut saved = saved_fights().lock().unwrap_or_else(|p| p.into_inner());
    saved.retain(|r| r.id != record.id);
    saved.push_back(record.clone());
    while saved.len() > MAX_SAVED {
        saved.pop_front();
    }
}

/// A saved fight as `a2.on("fight")` hands it on: the fight, your numbers
/// and skills, and each player's totals. `me` is your character's name.
pub fn fight_event(record: &FightRecord, me: Option<&str>) -> Value {
    let secs = (record.duration_ms as f64 / 1000.0).max(1.0);
    let mine: HashSet<i32> = record
        .actors
        .iter()
        .filter(|a| me.is_some_and(|me| a.nickname.trim() == me.trim()))
        .map(|a| a.actor_id)
        .collect();
    let damage_of = |id: i32| -> i64 {
        record.details.skills.iter().filter(|s| s.actor_id == id).map(|s| s.dmg as i64).sum()
    };
    let deaths_of = |id: i32| -> usize {
        record.details.deaths.as_ref().map_or(0, |d| d.iter().filter(|d| d.actor_id == id).count())
    };
    let players: Vec<Value> = record
        .actors
        .iter()
        .map(|a| {
            let damage = damage_of(a.actor_id);
            serde_json::json!({
                "name": a.nickname,
                "classId": a.job_id,
                "damage": damage,
                "dps": (damage as f64 / secs).round(),
                "deaths": deaths_of(a.actor_id),
                "me": mine.contains(&a.actor_id),
            })
        })
        .collect();
    let skills: Vec<&crate::entity::details_context::DetailSkillEntry> =
        record.details.skills.iter().filter(|s| mine.contains(&s.actor_id)).collect();
    let my_damage: i64 = skills.iter().map(|s| s.dmg as i64).sum();
    let sum = |f: fn(&crate::entity::details_context::DetailSkillEntry) -> i32| -> i64 {
        skills.iter().map(|s| f(s) as i64).sum()
    };
    let my_skills: Vec<Value> = skills
        .iter()
        .map(|s| {
            serde_json::json!({
                "code": s.code,
                "name": s.name,
                "damage": s.dmg,
                "hits": s.time,
                "crit": s.crit,
                "back": s.back,
                "perfect": s.perfect,
                "double": s.double,
                "parry": s.parry,
                "dot": s.is_dot,
            })
        })
        .collect();
    serde_json::json!({
        "id": record.id,
        "boss": record.boss_name,
        "mobCode": record.mob_code,
        "dungeonId": record.dungeon_id,
        "serverId": record.server_id,
        "isTrain": record.is_train,
        "startMs": record.start_time_ms,
        "durationMs": record.duration_ms,
        "totalDamage": record.total_damage,
        "players": players,
        "me": if mine.is_empty() { Value::Null } else { serde_json::json!({
            "name": me,
            "damage": my_damage,
            "dps": (my_damage as f64 / secs).round(),
            "hits": sum(|s| s.time),
            "crit": sum(|s| s.crit),
            "back": sum(|s| s.back),
            "perfect": sum(|s| s.perfect),
            "double": sum(|s| s.double),
            "parry": sum(|s| s.parry),
            "skills": my_skills,
        }) },
    })
}

/// Text to the clipboard, for a plugin with `feed:combat` (a fight's summary
/// to paste in the game's chat). A sandboxed frame may not write it itself.
#[tauri::command]
pub fn plugin_copy_text(app: tauri::AppHandle, window: tauri::WebviewWindow, text: String, plugin: Option<String>) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, COMBAT_FEED)?;
    app.clipboard().write_text(text.chars().take(MAX_COPIED).collect::<String>()).map_err(|e| e.to_string())
}

/// A desktop notification (a Windows toast, or the Linux desktop's), for a
/// plugin with `notify:system`: an event alert while the game is closed.
#[tauri::command]
pub fn plugin_system_notify(app: tauri::AppHandle, window: tauri::WebviewWindow, title: String, body: String, plugin: Option<String>) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, SYSTEM_NOTIFY)?;
    let clip = |s: String, n: usize| s.chars().take(n).collect::<String>();
    app.notification().builder().title(clip(title, 80)).body(clip(body, 300)).show().map_err(|e| e.to_string())
}

/// The permission for desktop notifications.
pub const SYSTEM_NOTIFY: &str = "notify:system";

// ── The dashboard ──────────────────────────────────────────────────────────

/// The dashboard's window: every bundled plugin in one place, as pages of a
/// sidebar (public/dashboard.html), with one Lock, Edit layout and Hide for
/// everything on screen. Made at start, hidden, so the plugins run; closing
/// it hides it.
pub const DASHBOARD: &str = "dashboard";
/// Whether the overlay (meter and widgets) is hidden from the dashboard.
const OVERLAY_HIDDEN_KEY: &str = "dashboard.overlayHidden";
/// Whether everything on screen is locked.
const OVERLAY_LOCKED_KEY: &str = "dashboard.overlayLocked";

/// Whether the dashboard opens with the app (Settings: off keeps it hidden
/// until opened from the meter's header).
pub fn shows_at_start(app: &tauri::AppHandle) -> bool {
    !setting(app, START_HIDDEN_KEY)
}
const START_HIDDEN_KEY: &str = "dashboard.startHidden";

/// Make the dashboard (hidden, unless `show`), or show it; on `module`'s page.
pub fn open_dashboard(app: &tauri::AppHandle, module: Option<&str>, show: bool) -> Result<(), String> {
    use tauri::Emitter;
    if let Some(window) = app.get_webview_window(DASHBOARD) {
        if show {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        if let Some(module) = module {
            let _ = window.emit("dashboard-show", module);
        }
        return Ok(());
    }
    let title = format!("{} — Dashboard", crate::fork::APP_NAME);
    crate::app::note_window_title(&title, DASHBOARD);
    let start = serde_json::to_string(&module).unwrap_or_else(|_| "null".into());
    tauri::WebviewWindowBuilder::new(app, DASHBOARD, tauri::WebviewUrl::App("dashboard.html".into()))
        .initialization_script(format!("window.__DASHBOARD_START__ = {start};"))
        .title(title)
        .inner_size(1180.0, 760.0)
        .min_inner_size(820.0, 520.0)
        .resizable(true)
        .visible(show || crate::platform::window::HIDE_AFTER_BUILD)
        .focused(show)
        .build()
        .map(|window| {
            if !show && crate::platform::window::HIDE_AFTER_BUILD {
                crate::platform::window::hide_without_focus(&window);
            }
        })
        .map_err(|e| e.to_string())
}

/// Open the dashboard, on a module's page if one is named.
#[tauri::command]
pub fn dashboard_open(app: tauri::AppHandle, module: Option<String>) -> Result<(), String> {
    open_dashboard(&app, module.as_deref(), true)
}

/// The modules the dashboard shows: the bundled plugins, on or off.
#[tauri::command]
pub fn dashboard_modules(app: tauri::AppHandle) -> Result<Value, String> {
    let view = super::plugin_list(app)?;
    let modules: Vec<Value> = view
        .plugins
        .iter()
        .filter(|p| p.bundled && p.error.is_none())
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "description": p.description,
                "enabled": !view.disabled.contains(&p.id),
                "widgets": p.permissions.iter().any(|x| x == "widgets"),
            })
        })
        .collect();
    Ok(serde_json::json!({ "modules": modules }))
}

/// The plugins whose widgets the dashboard's Lock and Edit layout cover.
fn widget_plugins(app: &tauri::AppHandle) -> Vec<String> {
    let Ok(host) = super::host(app) else { return Vec::new() };
    host.list().into_iter().filter(|p| p.permissions.iter().any(|x| x == "widgets")).map(|p| p.id).collect()
}

fn setting(app: &tauri::AppHandle, key: &str) -> bool {
    app.try_state::<AppState>().and_then(|s| s.settings.get(key)).as_deref() == Some("true")
}

fn set_setting(app: &tauri::AppHandle, key: &str, on: bool) {
    if let Some(state) = app.try_state::<AppState>() {
        state.settings.set(key, if on { "true" } else { "false" });
    }
}

/// Editing the layout: everything unlocked for now, the lock as it was after.
static EDITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the layout is being edited (the overlay takes the mouse).
pub fn editing() -> bool {
    EDITING.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether the dashboard's Hide all is on.
pub fn all_hidden(app: &tauri::AppHandle) -> bool {
    setting(app, OVERLAY_HIDDEN_KEY)
}

/// Whether the dashboard's Lock is on: it is until turned off, so the overlay
/// lets every click through to the game from the start.
pub fn all_locked(app: &tauri::AppHandle) -> bool {
    app.try_state::<AppState>().and_then(|s| s.settings.get(OVERLAY_LOCKED_KEY)).as_deref() != Some("false")
}

fn overlay_value(app: &tauri::AppHandle) -> Value {
    serde_json::json!({
        "locked": all_locked(app),
        "editing": editing(),
        "hidden": setting(app, OVERLAY_HIDDEN_KEY),
        "meterShown": crate::app::meter_wanted(app),
    })
}

fn tell_overlay(app: &tauri::AppHandle) {
    use tauri::Emitter;
    let value = overlay_value(app);
    let _ = app.emit_to(DASHBOARD, "overlay-state", value.clone());
    // Plugins hear it as "layout" (an editing plugin shows what it would show).
    super::broadcast(app, "layout", value);
    super::overlay::refresh(app);
}

/// Lock, Edit layout and Hide, as they are.
#[tauri::command]
pub fn overlay_state(app: tauri::AppHandle) -> Value {
    overlay_value(&app)
}

/// Lock (clicks go through to the game, nothing moves) or unlock everything
/// on screen: the meter and every plugin's widgets.
#[tauri::command]
pub fn overlay_lock_all(app: tauri::AppHandle, locked: bool) {
    set_setting(&app, OVERLAY_LOCKED_KEY, locked);
    EDITING.store(false, std::sync::atomic::Ordering::Relaxed);
    for id in widget_plugins(&app) {
        if let Some(state) = app.try_state::<AppState>() {
            state.settings.set(&format!("dpsMeter.pluginWidgetsLocked.{id}"), if locked { "true" } else { "false" });
        }
    }
    crate::app::apply_overlay_lock(&app, locked);
    tell_overlay(&app);
}

/// Edit layout: everything shown, the overlay taking the mouse to drag the
/// widgets about, and the plugins told to show their notices as samples;
/// off, the lock as it was.
#[tauri::command]
pub fn overlay_edit(app: tauri::AppHandle, editing: bool) {
    EDITING.store(editing, std::sync::atomic::Ordering::Relaxed);
    let locked = !editing && all_locked(&app);
    if editing && setting(&app, OVERLAY_HIDDEN_KEY) {
        show_all(&app, true);
    }
    crate::app::apply_overlay_lock(&app, locked);
    tell_overlay(&app);
}

/// Show or hide everything on screen: the meter and the widgets.
#[tauri::command]
pub fn overlay_show_all(app: tauri::AppHandle, shown: bool) {
    show_all(&app, shown);
    tell_overlay(&app);
}

fn show_all(app: &tauri::AppHandle, shown: bool) {
    set_setting(app, OVERLAY_HIDDEN_KEY, !shown);
    crate::app::set_meter_wanted(app, shown);
}

/// Where a bundled plugin's widget goes the first time, as fractions of the
/// overlay (its centre's x, its top's y), so a first Edit layout does not
/// stack them all in one place: notices at the top, a stun just above the
/// character, bars at the bottom, timers down the left.
pub fn default_place(id: &str, name: &str) -> Option<(f64, f64)> {
    Some(match (id, name) {
        ("notices", _) => (0.5, 0.06),
        ("combat-alerts", "loc") => (0.5, 0.36),
        ("combat-alerts", "debuff") => (0.5, 0.26),
        ("fight-records", "notice") => (0.5, 0.15),
        ("fight-records", "train") => (0.16, 0.42),
        ("pvp-overlay", _) => (0.86, 0.3),
        ("combat-assist", _) => (0.5, 0.74),
        ("ping", _) => (0.95, 0.015),
        ("event-timers", "bosses") => (0.9, 0.5),
        ("event-timers", _) => (0.06, 0.2),
        _ => return None,
    })
}

/// The Notices plugin: what the plugins in the dashboard say with a2.notify
/// shows on screen as its notice, a popup over the game.
pub const NOTICES: &str = "notices";

/// A plugin's short message (a2.notify), from the dashboard: to the Notices
/// plugin, which shows it over the game.
#[tauri::command]
pub fn plugin_toast(app: tauri::AppHandle, window: tauri::WebviewWindow, text: String, plugin: Option<String>) -> Result<(), String> {
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, "notify")?;
    let name = super::host(&app)?.with(&id, |l| l.manifest.name.clone()).unwrap_or_default();
    let event = serde_json::json!({
        "plugin": NOTICES,
        "event": "notice",
        "data": { "from": id, "name": name, "text": text.chars().take(300).collect::<String>(), "at": crate::clock::now_ms() },
    });
    super::emit_plugin(&app, NOTICES, event).map_err(|e| e.to_string())
}

// ── The World Map's files ──────────────────────────────────────────────────

/// The permission for the map's images and marker files.
pub const MAPS: &str = "maps";
/// The largest image or marker file taken.
const MAX_MAP_FILE: u64 = 24 * 1024 * 1024;

fn maps_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let state = app.try_state::<AppState>().ok_or("no app state")?;
    let dir = state.app_data_dir.join("maps");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The image kept for a map, as a data URL a sandboxed page can show.
fn map_image_of(app: &tauri::AppHandle, map: i32) -> Result<Option<String>, String> {
    let dir = maps_dir(app)?;
    for (ext, mime) in [("png", "image/png"), ("jpg", "image/jpeg"), ("webp", "image/webp")] {
        let path = dir.join(format!("{map}.{ext}"));
        if let Ok(bytes) = std::fs::read(&path) {
            return Ok(Some(format!("data:{mime};base64,{}", super::base64(&bytes))));
        }
    }
    Ok(None)
}

/// A map's image (your own screenshot of the game's world map), if one was picked.
#[tauri::command]
pub fn plugin_map_image(app: tauri::AppHandle, window: tauri::WebviewWindow, map: i32, plugin: Option<String>) -> Result<Option<String>, String> {
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, MAPS)?;
    map_image_of(&app, map)
}

/// Pick an image for a map: kept in the app's folder (`maps/<map>.<ext>`),
/// replacing the one before.
#[tauri::command]
pub async fn plugin_map_pick_image(app: tauri::AppHandle, window: tauri::WebviewWindow, map: i32, plugin: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, MAPS)?;
    let dialog = app.dialog().file().set_title("A screenshot of the world map").add_filter("Images", &["png", "jpg", "jpeg", "webp"]);
    let Some(picked) = tokio::task::spawn_blocking(move || dialog.blocking_pick_file()).await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_MAP_FILE {
        return Err("That image is too large (24 MB at most)".into());
    }
    let ext = match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("jpg" | "jpeg") => "jpg",
        Some("webp") => "webp",
        _ => "png",
    };
    let dir = maps_dir(&app)?;
    for old in ["png", "jpg", "webp"] {
        let _ = std::fs::remove_file(dir.join(format!("{map}.{old}")));
    }
    std::fs::copy(&path, dir.join(format!("{map}.{ext}"))).map_err(|e| e.to_string())?;
    map_image_of(&app, map)
}

/// Standard base64 (padding optional) to bytes; None on anything else.
fn from_base64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let bytes = bytes.strip_suffix(b"==").or_else(|| bytes.strip_suffix(b"=")).unwrap_or(&bytes);
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= value(c)? << (18 - 6 * i);
        }
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    Some(out)
}

/// An image's file type by its first bytes: PNG, JPEG or WebP, or none.
fn image_kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// Keep an image for a map from the page itself (pasted, or dropped on the
/// map): a `data:` URL of a PNG, JPEG or WebP. It replaces the one before.
#[tauri::command]
pub fn plugin_map_save_image(app: tauri::AppHandle, window: tauri::WebviewWindow, map: i32, data: String, plugin: Option<String>) -> Result<Option<String>, String> {
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, MAPS)?;
    if data.len() as u64 > MAX_MAP_FILE * 4 / 3 + 64 {
        return Err("That image is too large (24 MB at most)".into());
    }
    let encoded = data.split_once(";base64,").map(|(_, b)| b).ok_or("not an image")?;
    let bytes = from_base64(encoded).ok_or("not an image")?;
    let ext = image_kind(&bytes).ok_or("Only PNG, JPEG or WebP images")?;
    let dir = maps_dir(&app)?;
    for old in ["png", "jpg", "webp"] {
        let _ = std::fs::remove_file(dir.join(format!("{map}.{old}")));
    }
    std::fs::write(dir.join(format!("{map}.{ext}")), bytes).map_err(|e| e.to_string())?;
    map_image_of(&app, map)
}

/// The game's top-right corner as on screen, for the map to find you on by
/// its minimap: a PNG `data:` URL, with the game picture's size.
#[tauri::command]
pub async fn plugin_map_minimap(app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: Option<String>) -> Result<serde_json::Value, String> {
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, MAPS)?;
    let corner = tokio::task::spawn_blocking(crate::platform::screenshot::game_corner).await.map_err(|e| e.to_string())??;
    let png = crate::platform::screenshot::encode_png(corner.width, corner.height, &corner.rgba);
    Ok(serde_json::json!({
        "png": format!("data:image/png;base64,{}", super::base64(&png)),
        "gameWidth": corner.game_width,
        "gameHeight": corner.game_height,
    }))
}

/// Pick a marker file (JSON or CSV) and hand over its text, for the map to read.
#[tauri::command]
pub async fn plugin_map_pick_markers(app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let id = super::plugin_of(&window, plugin)?;
    super::require(&app, &id, MAPS)?;
    let dialog = app.dialog().file().set_title("A marker file").add_filter("Markers", &["json", "csv", "txt"]);
    let Some(picked) = tokio::task::spawn_blocking(move || dialog.blocking_pick_file()).await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_MAP_FILE {
        return Err("That file is too large (24 MB at most)".into());
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

/// The longest text a plugin may copy.
const MAX_COPIED: usize = 2000;

/// The combat feed's side of the plugin event loop.
#[derive(Default)]
pub struct Ticker {
    /// The game data, and the language it was read in.
    data: Option<(String, FeedData)>,
    last: Option<Snapshot>,
    sent: Option<Instant>,
}

impl Ticker {
    /// Send the snapshot and any saved fights to the plugins with
    /// `feed:combat`, if any is loaded.
    pub fn tick(&mut self, app: &tauri::AppHandle, host: &PluginHost) {
        let wanted = host
            .loaded
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|l| l.manifest.permissions.iter().any(|p| p == COMBAT_FEED));
        let Some(state) = app.try_state::<AppState>() else { return };
        let fights: Vec<FightRecord> = saved_fights().lock().unwrap_or_else(|p| p.into_inner()).drain(..).collect();
        if !wanted {
            return;
        }
        let me_name = state.data_storage.local_character_name();
        for record in &fights {
            host.tell_permitted(app, COMBAT_FEED, "fight", fight_event(record, me_name.as_deref()));
        }

        let lang = state.settings.get("dpsMeter.language").unwrap_or_else(|| "en".into());
        if self.data.as_ref().is_none_or(|(l, _)| *l != lang) {
            let data = state.i18n_data_dir.as_deref().map(|d| FeedData::load(d, &lang)).unwrap_or_default();
            self.data = Some((lang, data));
        }
        let Some((_, data)) = self.data.as_ref() else { return };

        let storage = &state.data_storage;
        let me = storage.local_player_id().and_then(|id| i32::try_from(id).ok());
        let party: Vec<PartyView> = storage
            .party_entities()
            .into_iter()
            .map(|(id, name, class)| PartyView { id, name, class_id: class.map(|c| c.class_prefix()) })
            .collect();
        let abnormals = storage.live_abnormals();
        let now = crate::clock::now_ms();
        let snapshot = storage.combat_feed().snapshot(now, &SnapshotContext {
            me,
            data,
            party: &party,
            abnormals: &abnormals,
            dungeon_id: storage.current_dungeon_id(),
            map_id: storage.current_map(),
            mob_code_of: &|id| storage.mob_code(id),
            name_of: &|id| storage.get_nickname(id),
            hp_of: &|id| storage.last_hp(id),
            dead: &|id| storage.is_entity_dead(id) || storage.last_hp(id) == Some(0),
            deaths_of_me: &|from| me.map_or(0, |me| storage.deaths_since(me, from)),
        });
        let changed = self.last.as_ref().is_none_or(|last| Snapshot { now_ms: last.now_ms, ..snapshot.clone() } != *last);
        if changed || self.sent.is_none_or(|at| at.elapsed() >= RESEND) {
            if let Ok(value) = serde_json::to_value(&snapshot) {
                host.tell_permitted(app, COMBAT_FEED, "combat", value);
            }
            self.sent = Some(Instant::now());
            self.last = Some(snapshot);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_pasted_image_decodes_and_is_known_by_its_bytes() {
        assert_eq!(super::from_base64("aGVsbG8=").as_deref(), Some(&b"hello"[..]));
        assert_eq!(super::from_base64("aGVsbG8").as_deref(), Some(&b"hello"[..]));
        assert_eq!(super::from_base64("aGk*"), None);
        assert_eq!(super::image_kind(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
        assert_eq!(super::image_kind(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(super::image_kind(b"<svg"), None);
    }

    use super::*;

    #[test]
    fn a_fight_event_has_your_numbers_and_everyones_totals() {
        let actor = |id: i32, name: &str| serde_json::json!({ "actorId": id, "nickname": name, "jobId": 11 });
        let skill = |actor: i32, code: i32, dmg: i32, crit: i32| serde_json::json!({
            "actorId": actor, "code": code, "name": "S", "time": 4, "dmg": dmg, "multiHitCount": 0,
            "multiHitDamage": 0, "crit": crit, "parry": 0, "back": 0, "perfect": 0, "double": 0, "regen": 0,
        });
        let record: FightRecord = serde_json::from_value(serde_json::json!({
            "id": "f1", "bossName": "Boss", "targetId": 9, "startTimeMs": 0, "durationMs": 10_000,
            "totalDamage": 3000, "jobs": [], "actors": [actor(1, "Me"), actor(2, "Friend")],
            "details": {
                "targetId": 9, "totalTargetDamage": 3000, "battleTime": 10_000,
                "skills": [skill(1, 11020000, 1500, 2), skill(1, 11030000, 500, 1), skill(2, 12020000, 1000, 0)],
            },
        }))
        .expect("a minimal record reads");
        let e = fight_event(&record, Some("Me"));
        assert_eq!(e["me"]["damage"], 2000);
        assert_eq!(e["me"]["dps"], 200.0);
        assert_eq!(e["me"]["crit"], 3);
        assert_eq!(e["me"]["hits"], 8);
        assert_eq!(e["me"]["skills"].as_array().map(Vec::len), Some(2));
        assert_eq!(e["players"][1]["damage"], 1000);
        assert_eq!(e["players"][0]["me"], true);
        assert!(fight_event(&record, Some("Nobody"))["me"].is_null());
    }
}
