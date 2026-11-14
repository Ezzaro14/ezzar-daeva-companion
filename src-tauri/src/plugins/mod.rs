//! Plugins: features beside the meter, kept out of its core (docs/plugins-design.md).
//!
//! A plugin is a folder: `manifest.json`, an `index.html` and its scripts and
//! data. It runs in a window of its own (`plugin-<id>`), inside a sandboxed
//! frame with an origin of its own (the `a2plugin` scheme served here), no
//! network and no access to the meter: it talks only to the host page, which
//! passes on what its manifest's permissions allow. Game data reaches it
//! through its own decoders (`decoder`), as numbers.
//!
//! Two kinds load: the modules that come with the app (`bundled`), always;
//! and in developer mode, plugins from local folders, for authors to build
//! and test them. A folder with a module's id runs in that module's place.

#[cfg(feature = "online")]
pub mod armory;
/// Without the network there is no official site to read.
#[cfg(not(feature = "online"))]
pub mod armory {
    pub const ARMORY: &str = "feed:armory";
    #[tauri::command]
    pub fn plugin_armory_character(name: Option<String>, server: Option<u16>, refresh: Option<bool>, plugin: Option<String>) -> Result<serde_json::Value, String> {
        let _ = (name, server, refresh, plugin);
        Err("the Progression Guide needs the online build".into())
    }
    #[tauri::command]
    pub fn plugin_armory_pool(class: i32, server: u16, extra: Option<Vec<serde_json::Value>>, plugin: Option<String>) -> Result<(), String> {
        let _ = (class, server, extra, plugin);
        Err("the Progression Guide needs the online build".into())
    }
}
pub mod bundled;
pub mod decoder;
pub mod overlay;
pub mod pet_catalog;
pub mod widgets;
#[cfg(feature = "online")]
pub mod boss_live;
/// Without the network there is nothing to follow.
#[cfg(not(feature = "online"))]
pub mod boss_live {
    #[tauri::command]
    pub fn plugin_boss_follow(_server: u32, _bosses: Vec<String>) -> Result<(), String> {
        Err("live boss updates need the online build".into())
    }
    pub fn forget_plugin(_app: &tauri::AppHandle, _id: &str) {}
}

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::Digest;
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::app::AppState;
use decoder::{Decoder, DecoderSpec};

/// Developer mode on or off.
pub const DEV_MODE_KEY: &str = "dpsMeter.pluginDevMode";
/// The folders loaded in developer mode, a JSON array of paths.
pub const DEV_FOLDERS_KEY: &str = "dpsMeter.devPlugins";
/// How often plugins' "game" event (is AION2 open) is looked at.
const GAME_CHECK: Duration = Duration::from_secs(5);
/// The scheme plugin files are served from (`http://a2plugin.localhost/` on
/// Windows, `a2plugin://localhost/` elsewhere).
pub const SCHEME: &str = "a2plugin";
/// The newest plugin API this meter speaks; it runs older ones too.
/// 2 added decoders' `self` field and `a2.window` (the `window` permission).
const API_VERSION: u32 = 2;
/// Plugins turned off in Settings, a JSON array of ids: they stay installed
/// but don't run. Every other plugin starts with the meter.
pub const DISABLED_KEY: &str = "dpsMeter.pluginsDisabled";
/// Plugins whose widgets hide while AION2 is closed, a JSON array of ids
/// (Settings → Plugins).
pub const HIDE_CLOSED_KEY: &str = "dpsMeter.pluginsHideClosed";
/// Plugins whose widgets hide with the meter when AION2 isn't in front (the
/// meter's "Hide when AION2 isn't focused"), a JSON array of ids. Off by
/// default: an alert's icon is most use while the game isn't in front.
pub const HIDE_UNFOCUSED_KEY: &str = "dpsMeter.pluginsHideUnfocused";
/// Whether AION2 is open, as the plugin event loop last looked.
static GAME_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// The plugins listed under a setting (`HIDE_CLOSED_KEY`, `HIDE_UNFOCUSED_KEY`).
fn listed(app: &tauri::AppHandle, key: &str) -> Vec<String> {
    app.try_state::<AppState>()
        .and_then(|s| s.settings.get(key))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The plugins that hide while AION2 is closed.
fn hide_closed(app: &tauri::AppHandle) -> Vec<String> {
    listed(app, HIDE_CLOSED_KEY)
}

/// Whether plugin `id`'s widgets hide with the meter when AION2 isn't in
/// front.
pub fn hides_unfocused(app: &tauri::AppHandle, id: &str) -> bool {
    listed(app, HIDE_UNFOCUSED_KEY).iter().any(|x| x == id)
}

/// Whether `id`'s widgets are to stay hidden now: AION2 closed, and the
/// plugin set to hide then.
pub fn game_hides(app: &tauri::AppHandle, id: &str) -> bool {
    !GAME_OPEN.load(std::sync::atomic::Ordering::Relaxed) && hide_closed(app).iter().any(|x| x == id)
}

/// Hide the widgets of the plugins set to hide while AION2 is closed, or
/// show them again: on the game opening or closing, and on the setting
/// changing. The overlay draws them, so it is told.
pub fn sync_game_hiding(app: &tauri::AppHandle) {
    overlay::refresh(app);
}
/// Largest value one storage key may hold.
const MAX_STORED: usize = 1024 * 1024;
/// How long a decoded event waits before it is stamped with the character and
/// sent. At login the game sends some data (the pet list) a few records
/// before the one that says which character is playing; the wait lets that
/// record land first, so the data is filed under the right character. Only
/// plugins that are told the character (`events:character`) wait, and not
/// for decoders marked `immediate`; the others get each event as it is read.
const SETTLE: Duration = Duration::from_millis(500);
/// Events kept per plugin for the run, replayed to its page when it starts.
const MAX_LOGGED: usize = 20_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing)]
    pub decoders: Vec<DecoderSpec>,
    #[serde(default)]
    pub ui: Option<Value>,
}

struct Loaded {
    manifest: Manifest,
    dir: PathBuf,
    decoders: Vec<Decoder>,
    /// Comes with the app (the same as `bundled`), not a developer folder.
    reviewed: bool,
    /// Shipped with the meter (`bundled`).
    bundled: bool,
}

/// What Settings lists.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub path: String,
    pub permissions: Vec<String>,
    /// Comes with the app (otherwise a developer folder).
    pub reviewed: bool,
    /// Shipped with the meter: it can be turned off, not removed.
    pub bundled: bool,
    /// Set when the folder could not be loaded.
    pub error: Option<String>,
}

/// What Settings shows: developer mode, and each folder's plugin (or error).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsView {
    pub dev_mode: bool,
    pub plugins: Vec<PluginInfo>,
    /// Ids of the plugins turned off.
    pub disabled: Vec<String>,
    /// Ids of the plugins that hide while AION2 is closed.
    pub hide_closed: Vec<String>,
    /// Ids of the plugins that hide with the meter when AION2 isn't in front.
    pub hide_unfocused: Vec<String>,
}

fn view(app: &tauri::AppHandle, host: &PluginHost) -> PluginsView {
    let dev_mode = app
        .try_state::<AppState>()
        .is_some_and(|s| s.settings.get(DEV_MODE_KEY).as_deref() == Some("true"));
    PluginsView {
        dev_mode,
        plugins: host.list(),
        disabled: disabled(app),
        hide_closed: hide_closed(app),
        hide_unfocused: listed(app, HIDE_UNFOCUSED_KEY),
    }
}

/// The plugins turned off.
fn disabled(app: &tauri::AppHandle) -> Vec<String> {
    app.try_state::<AppState>()
        .and_then(|s| s.settings.get(DISABLED_KEY))
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn set_disabled(app: &tauri::AppHandle, id: &str, off: bool) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let mut ids = disabled(app);
    ids.retain(|x| x != id);
    if off {
        ids.push(id.to_string());
    }
    state.settings.set(DISABLED_KEY, &serde_json::to_string(&ids).unwrap_or_default());
}

/// Turn a plugin on (it starts now and with every start of the meter) or off
/// (it stops, and its widgets go; it stays installed, with its data). The
/// dashboard runs it, from Settings as from its own switch.
#[tauri::command]
pub fn plugin_set_enabled(app: tauri::AppHandle, id: String, enabled: bool) -> Result<PluginsView, String> {
    if !valid_id(&id) {
        return Err("not a plugin id".into());
    }
    set_disabled(&app, &id, !enabled);
    if !enabled {
        stopped(&app, &id);
    }
    bundled::modules_changed(&app, &[]);
    tracing::info!("Plugins: {id} {}", if enabled { "enabled" } else { "disabled" });
    let host = host(&app)?;
    Ok(view(&app, &host))
}

/// A plugin stopped (turned off, removed): its widgets leave the screen, and
/// the field bosses it followed are no longer followed for it.
fn stopped(app: &tauri::AppHandle, id: &str) {
    widgets::close_all(app, id);
    boss_live::forget_plugin(app, id);
}

/// Hide a plugin's widgets while AION2 is closed (`when`
/// "closed"), or with the meter while AION2 isn't in front ("unfocused"), or
/// not.
#[tauri::command]
pub fn plugin_set_hide(app: tauri::AppHandle, id: String, when: String, hide: bool) -> Result<PluginsView, String> {
    if !valid_id(&id) {
        return Err("not a plugin id".into());
    }
    let key = match when.as_str() {
        "closed" => HIDE_CLOSED_KEY,
        "unfocused" => HIDE_UNFOCUSED_KEY,
        _ => return Err("closed or unfocused".into()),
    };
    let state = app.try_state::<AppState>().ok_or("no app state")?;
    let mut ids = listed(&app, key);
    ids.retain(|x| x != &id);
    if hide {
        ids.push(id.clone());
    }
    state.settings.set(key, &serde_json::to_string(&ids).unwrap_or_default());
    sync_game_hiding(&app);
    let host = host(&app)?;
    Ok(view(&app, &host))
}

/// A decoded event waiting out `SETTLE`.
struct Pending {
    at: Instant,
    /// Waits out `SETTLE` (the plugin is told the character, and the
    /// decoder isn't `immediate`).
    settle: bool,
    /// When the record was read, unix ms: plugins get it as `at`, so one
    /// can tell how old an event is however long it waited.
    read_ms: i64,
    plugin: String,
    event: String,
    data: Value,
}

/// Decoded events reach a plugin exactly once and in order, whether or not
/// its page is running: each is numbered and kept for the run (`log`), the
/// dashboard replays to a page the ones it has not delivered yet, and a run
/// id tells it when the numbering started over (the meter restarted).
pub struct PluginHost {
    loaded: RwLock<Vec<Loaded>>,
    errors: RwLock<Vec<PluginInfo>>,
    pending: Mutex<Vec<Pending>>,
    /// Wakes the flusher when an event is queued.
    queued: Condvar,
    log: Mutex<HashMap<String, VecDeque<Value>>>,
    seq: Mutex<u64>,
    run: String,
    flusher: AtomicBool,
}

impl Default for PluginHost {
    fn default() -> Self {
        let run = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis().to_string())
            .unwrap_or_default();
        PluginHost {
            loaded: RwLock::default(),
            errors: RwLock::default(),
            pending: Mutex::default(),
            queued: Condvar::new(),
            log: Mutex::default(),
            seq: Mutex::new(0),
            run,
            flusher: AtomicBool::new(false),
        }
    }
}

/// The Abyss artifacts' holders as the game told this player, as
/// a2.on("abyss") hands them on: the shape of the site's file (times in unix
/// seconds, owners by name).
fn abyss_event(state: &crate::capture::abyss_artifacts::ArtifactState, seen_ms: i64) -> Value {
    let secs = |ms: i64| (ms > 0).then_some(ms / 1000);
    let wars: Vec<_> = state.wars.iter()
        .map(|w| serde_json::json!({ "event": w.event_id, "since": secs(w.since_ms), "until": secs(w.until_ms) }))
        .collect();
    let artifacts: Vec<_> = state.artifacts.iter()
        .map(|a| serde_json::json!({ "id": a.id, "event": a.event_id(), "owner": a.owner.name() }))
        .collect();
    serde_json::json!({ "observedAt": seen_ms / 1000, "wars": wars, "artifacts": artifacts })
}

/// A map the player opened, as a2.on("bossMap") hands it on: the feed's
/// shape (times in unix seconds), each boss stamped with when it was read.
fn boss_map_event(map: &crate::capture::boss_map::BossMap) -> Value {
    let secs = |ms: i64| (ms > 0).then_some(ms / 1000);
    let bosses: serde_json::Map<String, Value> = map
        .bosses
        .iter()
        .map(|b| {
            let entry = serde_json::json!({
                "state": if b.up { "up" } else { "dead" },
                "upSince": if b.up { secs(b.time_ms) } else { None },
                "nextSpawn": if b.up { None } else { secs(b.time_ms) },
                "reportedAt": map.seen_ms / 1000,
                "confirmed": true,
            });
            (b.id.to_string(), entry)
        })
        .collect();
    serde_json::json!({ "map": map.map_id, "bosses": bosses })
}

/// Who is playing, as plugins with `events:character` see it.
fn character(app: &tauri::AppHandle) -> Option<Value> {
    app.try_state::<AppState>().map(|s| {
        let p = s.data_storage.local_profile();
        // Owner, energy, counts, times, shop limits, crafts, Kinah and Abyss
        // Points from one moment: a login's list replaces them all at once.
        let list = s.data_storage.entry_list();
        let theirs = matches!((list.owner.as_deref(), p.name.as_deref()), (Some(o), Some(n)) if o.trim() == n.trim());
        let odyle = list
            .odyle_energy
            .filter(|_| theirs)
            .map(|(basic, charged)| serde_json::json!({ "basic": basic, "charged": charged }));
        // The game's entry counts by id, as `[first, second]`, theirs the same
        // way (they come in Odyle energy's list). Known ids: 1 Shugo
        // Festival keys, 4 Nightmare, 8 Dimensional Invasion, 101 Daily
        // Dungeon, 60000001 Odyle energy, 80000001 Ascension Trial; 0 the
        // character's Daily Duty today, [completed, taken] (data_storage).
        // Started mid-session, the app has only the entries that changed
        // since, until the next login or transfer.
        let content = (theirs && !list.counts.is_empty()).then(|| serde_json::json!(list.counts));
        // The shop's weekly purchase limits by item id, `[bought, next reset
        // ms]` (100134 Buy Odyle Energy, 100135 Buy Rift Stones), and the
        // crafts made by recipe (32070001 Odyle Energy, server-wide; 32070002
        // the character's). Past its reset a limit is `[0, null]`.
        let shop = (theirs && !list.shop_limits.is_empty()).then(|| serde_json::json!(list.shop_limits));
        let crafts = (theirs && !list.crafts.is_empty()).then(|| serde_json::json!(list.crafts));
        serde_json::json!({
            "name": p.name,
            "serverId": p.server_id,
            "level": p.level,
            "class": p.class.map(|c| c.class_name().to_string()),
            "combatPower": p.combat_power,
            "gearScore": p.gear_score,
            "odyleEnergy": odyle,
            "contentCounts": content,
            "shopLimits": shop,
            "crafts": crafts,
            // Kinah gained today, and the Abyss Points this week with the
            // week's limit: 0 once their reset has passed.
            "kinahToday": list.kinah_today.filter(|_| theirs),
            "abyssPoints": list.abyss_points.filter(|_| theirs).map(|(p, l)| [p, l]),
            // The entry list's time entries by id, `[time, seen at ms]`: the
            // Abyss passages 10000001-10000003 each with its usage time left
            // (ms) while it can still be run.
            "contentTimes": Some(list.times).filter(|t| theirs && !t.is_empty()),
        })
    })
}

/// Take the events that may go now, in order: one that doesn't settle, or
/// has waited out `SETTLE`, unless an earlier event of its plugin is still
/// waiting (an `immediate` soul pickup never overtakes the pet list before it).
fn take_ready(pending: &mut Vec<Pending>, now: Instant) -> Vec<Pending> {
    let mut held: Vec<String> = Vec::new();
    let mut ready = Vec::new();
    for p in std::mem::take(pending) {
        let due = !p.settle || now.duration_since(p.at) >= SETTLE;
        if due && !held.contains(&p.plugin) {
            ready.push(p);
        } else {
            if !held.contains(&p.plugin) {
                held.push(p.plugin.clone());
            }
            pending.push(p);
        }
    }
    ready
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Read and check a plugin folder's manifest.
fn load_folder(dir: &Path) -> Result<Loaded, String> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).map_err(|e| format!("no manifest.json: {e}"))?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|e| format!("manifest.json: {e}"))?;
    if !valid_id(&manifest.id) {
        return Err(format!("id {:?}: lowercase letters, digits and '-' only", manifest.id));
    }
    if manifest.api_version == 0 || manifest.api_version > API_VERSION {
        return Err(format!("apiVersion {} (this meter speaks up to {API_VERSION}): update the meter", manifest.api_version));
    }
    if !dir.join("index.html").is_file() {
        return Err("no index.html".into());
    }
    let mut decoders = Vec::new();
    for spec in &manifest.decoders {
        let decoder = Decoder::compile(spec)?;
        if !manifest.permissions.iter().any(|p| p == &format!("decoder:{}", decoder.name)) {
            return Err(format!("decoder {} needs the permission \"decoder:{}\"", decoder.name, decoder.name));
        }
        decoders.push(decoder);
    }
    Ok(Loaded { manifest, dir: dir.to_path_buf(), decoders, reviewed: false, bundled: false })
}

impl PluginHost {
    /// Load the modules that come with the app, and in developer mode the
    /// folders the settings list. A developer folder wins over the module of
    /// the same id, so its author tests their own files.
    pub fn reload(self: &Arc<Self>, app: &tauri::AppHandle) {
        let Some(state) = app.try_state::<AppState>() else { return };
        let dev = state.settings.get(DEV_MODE_KEY).as_deref() == Some("true");
        let folders: Vec<String> = if dev {
            state.settings.get(DEV_FOLDERS_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut loaded = Vec::new();
        let mut errors = Vec::new();
        for folder in folders {
            match load_folder(Path::new(&folder)) {
                Ok(l) if loaded.iter().any(|x: &Loaded| x.manifest.id == l.manifest.id) => errors.push(PluginInfo {
                    error: Some(format!("another folder already loads {:?}", l.manifest.id)),
                    ..info(&l)
                }),
                Ok(l) => loaded.push(l),
                Err(e) => errors.push(PluginInfo {
                    id: String::new(),
                    name: folder.clone(),
                    version: String::new(),
                    description: String::new(),
                    path: folder,
                    permissions: Vec::new(),
                    reviewed: false,
                    bundled: false,
                    error: Some(e),
                }),
            }
        }
        // The bundled ones, where no developer folder has the id.
        for dir in bundled::dirs(app) {
            match load_folder(&dir) {
                Ok(l) if loaded.iter().any(|x: &Loaded| x.manifest.id == l.manifest.id) => {}
                Ok(l) => loaded.push(Loaded { reviewed: true, bundled: true, ..l }),
                Err(e) => tracing::warn!("Plugins: bundled {} does not load: {e}", dir.display()),
            }
        }
        let any_decoders = loaded.iter().any(|l| !l.decoders.is_empty());
        tracing::info!("Plugins: {} loaded (developer mode {})", loaded.len(), if dev { "on" } else { "off" });
        *self.loaded.write().unwrap_or_else(|p| p.into_inner()) = loaded;
        *self.errors.write().unwrap_or_else(|p| p.into_inner()) = errors;

        if !self.flusher.swap(true, Ordering::SeqCst) {
            let host = Arc::clone(self);
            let app = app.clone();
            std::thread::Builder::new()
                .name("plugin-events".into())
                .spawn(move || {
                let mut told = character(&app);
                let mut game = crate::platform::window_detector::find_aion2_window();
                GAME_OPEN.store(game, std::sync::atomic::Ordering::Relaxed);
                sync_game_hiding(&app);
                let mut game_checked = Instant::now();
                let mut ping: Option<i32> = None;
                let mut map_seq = 0u64;
                let mut abyss_seq = 0u64;
                let mut ticker = bundled::Ticker::default();
                let mut ticked = Instant::now();
                loop {
                    // Woken by each queued event; the timeout lets settling
                    // events go once their wait is over.
                    let ready = {
                        let mut pending = host.pending.lock().unwrap_or_else(|p| p.into_inner());
                        let mut ready = take_ready(&mut pending, Instant::now());
                        if ready.is_empty() {
                            let wait = if pending.is_empty() { bundled::TICK } else { Duration::from_millis(50) };
                            pending = host.queued.wait_timeout(pending, wait).unwrap_or_else(|p| p.into_inner()).0;
                            ready = take_ready(&mut pending, Instant::now());
                        }
                        ready
                    };
                    host.flush(&app, ready);
                    if ticked.elapsed() >= bundled::TICK {
                        ticked = Instant::now();
                        ticker.tick(&app, &host);
                    }
                    // The character as the meter learns it (a login, a switch,
                    // or the meter starting mid-game): open plugins hear it then,
                    // not only when their window opens.
                    let now = character(&app);
                    if now != told {
                        host.tell_character(&app, now.clone());
                        told = now;
                    }
                    // A map the player opened: its field bosses, to plugins
                    // with feed:boss-timers at once (the shared feed lags).
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Some((next, maps)) = state.data_storage.boss_maps_since(map_seq) {
                            map_seq = next;
                            if let Some(map) = maps.iter().filter(|m| m.header == 0).max_by_key(|m| m.seen_ms) {
                                host.tell_permitted(&app, "feed:boss-timers", "bossMap", boss_map_event(map));
                            }
                        }
                        // Who holds the Abyss artifacts, as the game just
                        // told this player: at once, as the feed's "wars"
                        // and "artifacts" have it.
                        if let Some((next, artifacts, seen_ms)) = state.data_storage.abyss_artifacts_since(abyss_seq) {
                            abyss_seq = next;
                            if !artifacts.artifacts.is_empty() {
                                host.tell_permitted(&app, "feed:boss-timers", "abyss", abyss_event(&artifacts, seen_ms));
                            }
                        }
                    }
                    // The ping to the game server, when it changes (about every
                    // 10 s), to every plugin: a ping widget needs no permission.
                    let now_ping = app.try_state::<AppState>().and_then(|s| s.ping_tracker.current_ping_ms());
                    if now_ping != ping {
                        ping = now_ping;
                        host.tell_all(&app, "ping", serde_json::json!({ "ms": now_ping }));
                    }
                    // Whether AION2 is open, looked at every few seconds.
                    if game_checked.elapsed() >= GAME_CHECK {
                        game_checked = Instant::now();
                        let running = crate::platform::window_detector::find_aion2_window();
                        // The overlay follows the game to its screen.
                        overlay::fit(&app);
                        if running != game {
                            game = running;
                            host.tell_all(&app, "game", serde_json::json!({ "running": running }));
                            GAME_OPEN.store(running, std::sync::atomic::Ordering::Relaxed);
                            sync_game_hiding(&app);
                        }
                    }
                }
                })
                .ok();
        }

        // The tap is set only while some plugin has a decoder.
        if any_decoders {
            let host = Arc::clone(self);
            let app = app.clone();
            crate::capture::frame_tap::set(Some(Arc::new(move |packet: &[u8]| host.on_frame(&app, packet))));
        } else {
            crate::capture::frame_tap::set(None);
        }
    }

    fn on_frame(&self, app: &tauri::AppHandle, packet: &[u8]) {
        let len = crate::capture::stream_processor::read_varint(packet, 0).length;
        if len <= 0 {
            return;
        }
        let at = len as usize;
        let Some(opcode) = packet.get(at..at + 2) else { return };
        let body = &packet[at + 2..];
        let loaded = self.loaded.read().unwrap_or_else(|p| p.into_inner());
        for plugin in loaded.iter() {
            for d in plugin.decoders.iter().filter(|d| d.opcode == opcode) {
                let Some(data) = d.decode(body) else { continue };
                // Only the player's own doings, for a decoder that asks so.
                if let Some(field) = &d.self_field {
                    let me = app.try_state::<AppState>().and_then(|s| s.data_storage.local_player_id());
                    let theirs = data.get(field).and_then(Value::as_i64);
                    if me.is_none() || me != theirs {
                        continue;
                    }
                }
                let settle = !d.immediate && plugin.manifest.permissions.iter().any(|p| p == "events:character");
                self.pending.lock().unwrap_or_else(|p| p.into_inner()).push(Pending {
                    at: Instant::now(),
                    settle,
                    read_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or_default(),
                    plugin: plugin.manifest.id.clone(),
                    event: format!("decoded:{}", d.name),
                    data,
                });
                self.queued.notify_one();
            }
        }
    }

    /// Send events that are ready (`take_ready`): number them, stamp them
    /// with the character (for plugins allowed to know it), keep them in the
    /// run's log, and pass them to the plugin's window if it is open.
    fn flush(&self, app: &tauri::AppHandle, ready: Vec<Pending>) {
        if ready.is_empty() {
            return;
        }
        let who = character(app);
        for item in ready {
            let allowed = self
                .with(&item.plugin, |l| l.manifest.permissions.iter().any(|p| p == "events:character"))
                .unwrap_or(false);
            let seq = {
                let mut seq = self.seq.lock().unwrap_or_else(|p| p.into_inner());
                *seq += 1;
                *seq
            };
            // Named for its plugin: the dashboard runs every plugin, and
            // hands each event to the page it names.
            let event = serde_json::json!({
                "plugin": item.plugin,
                "seq": seq,
                "event": item.event,
                "data": item.data,
                "at": item.read_ms,
                "character": if allowed { who.clone() } else { None },
            });
            {
                let mut log = self.log.lock().unwrap_or_else(|p| p.into_inner());
                let list = log.entry(item.plugin.clone()).or_default();
                list.push_back(event.clone());
                while list.len() > MAX_LOGGED {
                    list.pop_front();
                }
            }
            let _ = emit_plugin(app, event);
        }
    }

    /// An unnumbered event to every loaded plugin (the dashboard hands it
    /// straight on).
    fn tell_all(&self, app: &tauri::AppHandle, event: &str, data: Value) {
        let ids: Vec<String> =
            self.loaded.read().unwrap_or_else(|p| p.into_inner()).iter().map(|l| l.manifest.id.clone()).collect();
        for id in ids {
            let msg = serde_json::json!({ "plugin": id, "event": event, "data": data });
            let _ = emit_plugin(app, msg);
        }
    }

    /// An unnumbered event to the plugins with a permission.
    fn tell_permitted(&self, app: &tauri::AppHandle, permission: &str, event: &str, data: Value) {
        let ids: Vec<String> = self
            .loaded
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|l| l.manifest.permissions.iter().any(|p| p == permission))
            .map(|l| l.manifest.id.clone())
            .collect();
        for id in ids {
            let msg = serde_json::json!({ "plugin": id, "event": event, "data": data });
            let _ = emit_plugin(app, msg);
        }
    }

    /// The character, to every plugin allowed to know it (the dashboard hands
    /// an unnumbered event straight on).
    fn tell_character(&self, app: &tauri::AppHandle, who: Option<Value>) {
        let Some(who) = who else { return };
        let ids: Vec<String> = self
            .loaded
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|l| l.manifest.permissions.iter().any(|p| p == "events:character"))
            .map(|l| l.manifest.id.clone())
            .collect();
        for id in ids {
            let event = serde_json::json!({ "plugin": id, "event": "character", "data": who });
            let _ = emit_plugin(app, event);
        }
    }

    fn list(&self) -> Vec<PluginInfo> {
        let mut out: Vec<PluginInfo> = self.loaded.read().unwrap_or_else(|p| p.into_inner()).iter().map(info).collect();
        out.extend(self.errors.read().unwrap_or_else(|p| p.into_inner()).iter().cloned());
        out
    }

    fn with<T>(&self, id: &str, f: impl FnOnce(&Loaded) -> T) -> Option<T> {
        self.loaded.read().unwrap_or_else(|p| p.into_inner()).iter().find(|l| l.manifest.id == id).map(f)
    }
}

fn info(l: &Loaded) -> PluginInfo {
    PluginInfo {
        id: l.manifest.id.clone(),
        name: l.manifest.name.clone(),
        version: l.manifest.version.clone(),
        description: l.manifest.description.clone(),
        path: l.dir.to_string_lossy().into_owned(),
        permissions: l.manifest.permissions.clone(),
        reviewed: l.reviewed,
        bundled: l.bundled,
        error: None,
    }
}

/// An event for a plugin (each names its plugin): to the dashboard, which
/// runs every plugin, each as a page of its own.
fn emit_plugin(app: &tauri::AppHandle, event: Value) -> tauri::Result<()> {
    app.emit_to(bundled::DASHBOARD, "plugin-event", event)
}

/// The plugin a call is for: the one the dashboard names (it runs every
/// plugin in one window, and says which page asks).
fn plugin_of(window: &tauri::WebviewWindow, plugin: Option<String>) -> Result<String, String> {
    if window.label() != bundled::DASHBOARD {
        return Err("only the dashboard runs plugins".into());
    }
    plugin.filter(|id| valid_id(id)).ok_or_else(|| "the dashboard names no plugin".to_string())
}

fn host(app: &tauri::AppHandle) -> Result<Arc<PluginHost>, String> {
    app.try_state::<Arc<PluginHost>>().map(|h| Arc::clone(&h)).ok_or_else(|| "plugins are not available".into())
}

fn data_file(app: &tauri::AppHandle, id: &str, key: &str) -> Result<PathBuf, String> {
    if key.is_empty() || key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("storage keys are letters, digits, '-' and '_'".into());
    }
    let state = app.try_state::<AppState>().ok_or("no app state")?;
    Ok(state.app_data_dir.join("plugin-data").join(id).join(format!("{key}.json")))
}

// ── Settings ───────────────────────────────────────────────────────────────

#[tauri::command]
pub fn plugin_list(app: tauri::AppHandle) -> Result<PluginsView, String> {
    Ok(view(&app, &*host(&app)?))
}

/// Turn developer mode on or off, and load or unload its plugins.
#[tauri::command]
pub fn plugin_set_dev_mode(app: tauri::AppHandle, enabled: bool) -> Result<PluginsView, String> {
    let state = app.try_state::<AppState>().ok_or("no app state")?;
    state.settings.set(DEV_MODE_KEY, if enabled { "true" } else { "false" });
    let host = host(&app)?;
    let before = ids(&host);
    host.reload(&app);
    reloaded(&app, &host, &before, &[]);
    Ok(view(&app, &host))
}

/// The plugins loaded now: each one's id, and the folder it runs from.
fn ids(host: &PluginHost) -> Vec<(String, String)> {
    host.list().into_iter().map(|p| (p.id, p.path)).collect()
}

/// After the plugins were read again (`before`: those loaded until then):
/// the widgets of each one gone, or now run from another folder (a
/// developer folder removed, and the bundled one back), leave the screen, and
/// the dashboard starts, stops and restarts its pages to match. `restart`
/// run their files anew, which may have changed on disk.
fn reloaded(app: &tauri::AppHandle, host: &PluginHost, before: &[(String, String)], restart: &[String]) {
    let now = ids(host);
    for (id, _) in before.iter().filter(|was| !now.contains(was)) {
        stopped(app, id);
    }
    bundled::modules_changed(app, restart);
}

/// Ask for a plugin folder and load it (developer mode).
/// Async, as the screenshot folder picker is: the dialog must not block the main thread.
#[tauri::command]
pub async fn plugin_add_folder(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<PluginsView, String> {
    let Some(folder) = crate::platform::screenshot::pick_folder(&window, None) else {
        return Ok(view(&app, &*host(&app)?));
    };
    load_folder(Path::new(&folder))?;
    let state = app.try_state::<AppState>().ok_or("no app state")?;
    let mut folders: Vec<String> =
        state.settings.get(DEV_FOLDERS_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    if !folders.contains(&folder) {
        folders.push(folder);
    }
    state.settings.set(DEV_FOLDERS_KEY, &serde_json::to_string(&folders).unwrap_or_default());
    let host = host(&app)?;
    let before = ids(&host);
    host.reload(&app);
    reloaded(&app, &host, &before, &[]);
    Ok(view(&app, &host))
}

/// A plugin whose version changed when its folder was read again.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdate {
    pub id: String,
    pub name: String,
    /// None for a plugin that did not load before.
    pub from: Option<String>,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub view: PluginsView,
    /// Versions that changed on disk (developer folders), now loaded.
    pub updated: Vec<PluginUpdate>,
}

/// Check for plugin updates: read every plugin folder again (a developer
/// plugin's source is its folder) and restart the dashboard's pages of those
/// not bundled so they run the new files.
#[tauri::command]
pub async fn plugin_check_updates(app: tauri::AppHandle) -> Result<UpdateCheck, String> {
    let host = host(&app)?;
    let before: HashMap<String, String> =
        host.list().into_iter().filter(|p| p.error.is_none()).map(|p| (p.id, p.version)).collect();
    let paths = ids(&host);
    host.reload(&app);
    let view = view(&app, &host);
    let updated = view
        .plugins
        .iter()
        .filter(|p| p.error.is_none() && before.get(&p.id) != Some(&p.version))
        .map(|p| PluginUpdate { id: p.id.clone(), name: p.name.clone(), from: before.get(&p.id).cloned(), to: p.version.clone() })
        .collect();
    let own: Vec<String> = host.list().into_iter().filter(|p| !p.bundled).map(|p| p.id).collect();
    reloaded(&app, &host, &paths, &own);
    Ok(UpdateCheck { view, updated })
}

/// Stop loading a folder (its saved data stays).
#[tauri::command]
pub fn plugin_remove_folder(app: tauri::AppHandle, path: String) -> Result<PluginsView, String> {
    let state = app.try_state::<AppState>().ok_or("no app state")?;
    let mut folders: Vec<String> =
        state.settings.get(DEV_FOLDERS_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    folders.retain(|f| f != &path);
    state.settings.set(DEV_FOLDERS_KEY, &serde_json::to_string(&folders).unwrap_or_default());
    let host = host(&app)?;
    let before = ids(&host);
    host.reload(&app);
    reloaded(&app, &host, &before, &[]);
    Ok(view(&app, &host))
}

/// Open a plugin: the dashboard, on its page.
/// Async: on Windows, building a window (the dashboard, if it is not up yet)
/// from a synchronous command deadlocks.
#[tauri::command]
pub async fn plugin_open(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if disabled(&app).contains(&id) {
        return Err("that plugin is turned off".into());
    }
    if host(&app)?.with(&id, |_| ()).is_none() {
        return Err("no such plugin".into());
    }
    bundled::open_dashboard(&app, Some(&id), true)
}

// ── The plugins' pages ─────────────────────────────────────────────────────

/// What a plugin's page in the dashboard needs to start: the manifest, the
/// run's events so far (the page delivers those it has not yet), and the
/// character (for `events:character`).
#[tauri::command]
pub fn plugin_hello(app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: Option<String>) -> Result<Value, String> {
    let id = plugin_of(&window, plugin)?;
    let host = host(&app)?;
    let manifest = host.with(&id, |l| l.manifest.clone()).ok_or("plugin not loaded")?;
    let replay: Vec<Value> =
        host.log.lock().unwrap_or_else(|p| p.into_inner()).get(&id).map(|l| l.iter().cloned().collect()).unwrap_or_default();
    let character =
        if manifest.permissions.iter().any(|p| p == "events:character") { character(&app) } else { None };
    let reviewed = host.with(&id, |l| l.reviewed).unwrap_or(false);
    let language = app.try_state::<AppState>().and_then(|s| s.settings.get("dpsMeter.language")).unwrap_or_else(|| "en".into());
    Ok(serde_json::json!({
        "manifest": manifest,
        "replay": replay,
        "run": host.run,
        "character": character,
        "language": language,
        "reviewed": reviewed,
        // In the dashboard, which has its own Lock and Edit layout for all.
        "hosted": window.label() == bundled::DASHBOARD,
        "game": crate::platform::window_detector::find_aion2_window(),
        "ping": app.try_state::<AppState>().and_then(|s| s.ping_tracker.current_ping_ms()),
    }))
}

/// Debug builds only: feed a game packet (hex, with its length prefix) to the
/// plugins as if it had arrived from the network, to test them end to end.
#[tauri::command]
pub fn plugin_debug_frame(app: tauri::AppHandle, hex: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("only in debug builds".into());
    }
    let clean: String = hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let bytes = (0..clean.len() / 2)
        .map(|i| u8::from_str_radix(&clean[i * 2..i * 2 + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|e| e.to_string())?;
    host(&app)?.on_frame(&app, &bytes);
    Ok(())
}

/// Tell every plugin something every plugin may know, such as the meter's
/// language when the user changes it.
pub fn broadcast(app: &tauri::AppHandle, event: &str, data: Value) {
    // By its label: a window's own `emit` goes to every window.
    let _ = app.emit_to(bundled::DASHBOARD, "plugin-event", serde_json::json!({ "event": event, "data": data }));
}

fn require(app: &tauri::AppHandle, id: &str, permission: &str) -> Result<(), String> {
    let has = host(app)?.with(id, |l| l.manifest.permissions.iter().any(|p| p == permission)).unwrap_or(false);
    if has { Ok(()) } else { Err(format!("the plugin lacks the {permission:?} permission")) }
}

/// A server's field boss timers, as other players' meters reported them to
/// a2tools.app (its public feed: this app reads it and sends nothing), for plugins with
/// `feed:boss-timers`: the published file as it is, or None when the server
/// has none yet. Kept a minute, so plugins asking often fetch it once.
#[tauri::command]
pub async fn plugin_boss_timers(app: tauri::AppHandle, window: tauri::WebviewWindow, server: u32, plugin: Option<String>) -> Result<Option<Value>, String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "feed:boss-timers")?;
    if !(1000..10000).contains(&server) {
        return Err("not a server id".into());
    }
    boss_timers(&app, server).await
}

/// A server's Abyss siege as other players' meters see it (a2tools.app's
/// public feed, as the boss timers): who holds each artifact and each Dimensional Core's
/// state and HP, the published file as it is, or None when the server has
/// none yet. For plugins with `feed:boss-timers`. Meter 2.0.72 on.
#[tauri::command]
pub async fn plugin_abyss_siege(app: tauri::AppHandle, window: tauri::WebviewWindow, server: u32, plugin: Option<String>) -> Result<Option<Value>, String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "feed:boss-timers")?;
    if !(1000..10000).contains(&server) {
        return Err("not a server id".into());
    }
    feed_file(&app, "abyss-artifacts", server).await
}

#[cfg(feature = "online")]
async fn boss_timers(app: &tauri::AppHandle, server: u32) -> Result<Option<Value>, String> {
    feed_file(app, "boss-timers", server).await
}

#[cfg(not(feature = "online"))]
async fn boss_timers(_app: &tauri::AppHandle, _server: u32) -> Result<Option<Value>, String> {
    Err("this meter is built without network features".into())
}

/// One server's file of a feed on the CDN (`feeds/<feed>/<server>.json`).
#[cfg(feature = "online")]
async fn feed_file(app: &tauri::AppHandle, feed: &'static str, server: u32) -> Result<Option<Value>, String> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<(&'static str, u32), (Instant, Option<Value>)>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Mutex::default);
    let key = (feed, server);
    // As long as the CDN keeps the file (max-age 2): a plugin following a
    // boss that is being fought reads it every few seconds, for its HP as it
    // falls and its kill (Event Timers' pinned bosses).
    if let Some((at, value)) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(&key) {
        if at.elapsed() < Duration::from_secs(2) {
            return Ok(value.clone());
        }
    }
    let state = app.try_state::<AppState>().ok_or("no app state")?;
    let url = format!("https://cdn.a2tools.app/feeds/{feed}/{server}.json");
    let res = state.http.get(&url).timeout(Duration::from_secs(15)).send().await.map_err(|e| e.to_string())?;
    let value = match res.status() {
        s if s == reqwest::StatusCode::NOT_FOUND => None,
        s if s.is_success() => Some(serde_json::from_str(&res.text().await.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?),
        s => return Err(format!("the feed answered {s}")),
    };
    cache.lock().unwrap_or_else(|p| p.into_inner()).insert(key, (Instant::now(), value.clone()));
    Ok(value)
}

#[cfg(not(feature = "online"))]
async fn feed_file(_app: &tauri::AppHandle, _feed: &'static str, _server: u32) -> Result<Option<Value>, String> {
    Err("this meter is built without network features".into())
}

#[tauri::command]
pub fn plugin_storage_get(app: tauri::AppHandle, window: tauri::WebviewWindow, key: String, plugin: Option<String>) -> Result<Option<String>, String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "storage")?;
    Ok(std::fs::read_to_string(data_file(&app, &id, &key)?).ok())
}

#[tauri::command]
pub fn plugin_storage_set(app: tauri::AppHandle, window: tauri::WebviewWindow, key: String, value: String, plugin: Option<String>) -> Result<(), String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "storage")?;
    if value.len() > MAX_STORED {
        return Err("value larger than 1 MB".into());
    }
    let file = data_file(&app, &id, &key)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(file, value).map_err(|e| e.to_string())
}

// ── The plugin files ───────────────────────────────────────────────────────

/// The `a2` object plugins load from `/_sdk/a2.js`.
const SDK: &str = include_str!("a2.js");
/// The look widgets share (fork): `/_sdk/widget.css`, the overlay's panels,
/// type and colours, for any plugin's widget to use.
const WIDGET_CSS: &str = include_str!("widget.css");

/// Serve `/<id>/<path>` from that plugin's folder, and `/_sdk/a2.js`.
/// The content policy for a plugin's files: its own folder and the SDK, and
/// nothing from anywhere else (no network at all).
///
/// The sources are named outright. A plugin page runs in a sandboxed frame,
/// whose origin is opaque, and WebKit (the Linux webview) matches `'self'`
/// against that opaque origin, so with `'self'` alone it refused the page's
/// own scripts and styles and plugins showed up unstyled and empty (2.0.60).
/// Chromium (WebView2) matches `'self'` against the URL instead. On Linux the
/// scheme itself is allowed too, in case WebKit does not match a path on a
/// custom scheme: that lets a plugin load another plugin's files, which gives
/// it nothing (each runs in the same sandbox, with only its own permissions).
fn content_policy(id: &str, icons: bool) -> String {
    let base = if cfg!(windows) { "http://a2plugin.localhost" } else { "a2plugin://localhost" };
    let mut own = format!("'self' {base}/_sdk/a2.js {base}/_sdk/widget.css");
    if valid_id(id) {
        own.push_str(&format!(" {base}/{id}/"));
    }
    if !cfg!(windows) {
        own.push_str(" a2plugin:");
    }
    let cdn = if icons { format!(" {}", bundled::ICON_CDN) } else { String::new() };
    format!(
        "default-src 'none'; script-src {own}; style-src {own} 'unsafe-inline'; img-src {own} data:{cdn};          font-src {own} data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    )
}

pub fn serve(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let path = percent_decode(path.trim_start_matches('/'));
    let first = path.split('/').next().unwrap_or("");
    // The game's icons, for the plugins shipped with the meter.
    let icons = host(app).ok().and_then(|h| h.with(first, |l| l.bundled)).unwrap_or(false);
    let policy = content_policy(first, icons);
    let respond = |status: u16, kind: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", kind)
            .header("Content-Security-Policy", policy.as_str())
            .header("X-Content-Type-Options", "nosniff")
            .body(body)
            .unwrap_or_default()
    };
    if path == "_sdk/a2.js" {
        return respond(200, "text/javascript; charset=utf-8", SDK.as_bytes().to_vec());
    }
    if path == "_sdk/widget.css" {
        return respond(200, "text/css; charset=utf-8", WIDGET_CSS.as_bytes().to_vec());
    }
    let Some((id, rest)) = path.split_once('/') else { return respond(404, "text/plain", Vec::new()) };
    let Ok(host) = host(app) else { return respond(404, "text/plain", Vec::new()) };
    let Some(dir) = host.with(id, |l| l.dir.clone()) else { return respond(404, "text/plain", Vec::new()) };
    // Inside the plugin's folder only.
    let (Ok(root), Ok(file)) = (dir.canonicalize(), dir.join(rest).canonicalize()) else {
        return respond(404, "text/plain", Vec::new());
    };
    if !file.starts_with(&root) || !file.is_file() {
        return respond(404, "text/plain", Vec::new());
    }
    // On Linux a plugin page gets its scripts, styles and images inlined:
    // WebKitGTK (2.54 at least) refuses every file a sandboxed frame (an
    // opaque origin) asks for from a custom scheme ("Unsafe attempt to load
    // URL … from origin null"), before the page's policy is even consulted,
    // so plugins showed their bare HTML and nothing ran (2.0.60, 2.0.61).
    // Inlining keeps the frame's opaque-origin sandbox, which
    // `allow-same-origin` (the other way out) would give up.
    if !cfg!(windows) && file.extension().is_some_and(|e| e == "html") {
        if let Ok(html) = std::fs::read_to_string(&file) {
            let (page, hashes) = inline_page(&html, &root, file.parent().unwrap_or(&root));
            let page = with_meter_fonts(&page);
            let policy = inlined_policy(id, &hashes, icons);
            return tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Content-Security-Policy", policy.as_str())
                .header("X-Content-Type-Options", "nosniff")
                .body(page.into_bytes())
                .unwrap_or_default();
        }
    }
    let kind = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    match std::fs::read(&file) {
        Ok(body) => respond(200, kind, body),
        Err(_) => respond(404, "text/plain", Vec::new()),
    }
}

/// A plugin page with its `<script src>`, stylesheet `<link>` and `<img src>`
/// replaced by the files themselves (images as `data:` URLs), and the SHA-256
/// of each inlined script for the policy. Only the SDK and files inside the
/// plugin's folder are inlined; any other tag is left as it is (and stays
/// refused).
fn inline_page(html: &str, root: &Path, page_dir: &Path) -> (String, Vec<String>) {
    let file_of = |src: &str| -> Option<PathBuf> {
        if src.contains(':') || src.starts_with('/') {
            return None;
        }
        let file = page_dir.join(percent_decode(src.split(['?', '#']).next()?)).canonicalize().ok()?;
        file.starts_with(root).then_some(file)
    };
    let read = |src: &str| -> Option<String> {
        if src.trim_start_matches('/') == "_sdk/a2.js" {
            return Some(SDK.to_string());
        }
        if src.trim_start_matches('/') == "_sdk/widget.css" {
            return Some(WIDGET_CSS.to_string());
        }
        std::fs::read_to_string(file_of(src)?).ok()
    };
    let image = |src: &str| -> Option<String> {
        let file = file_of(src)?;
        let kind = match file.extension()?.to_str()? {
            "png" => "image/png",
            "svg" => "image/svg+xml",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "jpg" | "jpeg" => "image/jpeg",
            _ => return None,
        };
        Some(format!("data:{kind};base64,{}", base64(&std::fs::read(file).ok()?)))
    };
    let mut out = String::with_capacity(html.len() * 2);
    let mut hashes = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest.find('>') else { break };
        let tag = &rest[..=end];
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with("<script") && rest[end + 1..].to_ascii_lowercase().starts_with("</script>") {
            if let Some(code) = attribute(tag, "src").and_then(|src| read(&src)) {
                // "</script" inside the code would end the element early.
                let code = code.replace("</script", "<\\/script");
                hashes.push(base64(&sha2::Sha256::digest(code.as_bytes())));
                out.push_str("<script>");
                out.push_str(&code);
                out.push_str("</script>");
                rest = &rest[end + 1 + "</script>".len()..];
                continue;
            }
        } else if lower.starts_with("<link") && attribute(tag, "rel").is_some_and(|r| r.eq_ignore_ascii_case("stylesheet")) {
            if let Some(css) = attribute(tag, "href").and_then(|href| read(&href)) {
                out.push_str("<style>");
                out.push_str(&css.replace("</style", "<\\/style"));
                out.push_str("</style>");
                rest = &rest[end + 1..];
                continue;
            }
        } else if lower.starts_with("<img") {
            if let Some((src, data)) = attribute(tag, "src").and_then(|src| image(&src).map(|d| (src, d))) {
                out.push_str(&tag.replacen(&src, &data, 1));
                rest = &rest[end + 1..];
                continue;
            }
        }
        out.push_str(tag);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    (out, hashes)
}

/// An attribute's value in an opening tag, quoted or not.
fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        if !lower[..at].chars().last().is_some_and(char::is_whitespace) {
            continue;
        }
        let Some(after) = tag[from..].trim_start().strip_prefix('=') else { continue };
        let after = after.trim_start();
        let value = match after.chars().next()? {
            q @ ('"' | '\'') => after[1..].split(q).next()?,
            _ => after.split(|c: char| c.is_whitespace() || c == '>' || c == '/').next()?,
        };
        return Some(value.to_string());
    }
    None
}

/// Standard base64, with padding.
pub(crate) fn base64(data: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { ABC[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// The policy for an inlined page: only its own inlined scripts run (by
/// hash), its inlined styles apply, and nothing loads from anywhere.
/// The meter's Linux fonts, under the names plugins ask for: Linux has
/// neither Segoe UI, Pretendard nor Bahnschrift, so plugin text fell back to
/// the system face while the meter itself shipped Saira and Pretendard. A
/// plugin page cannot load the meter's files (see `serve`), so they come in
/// the page itself, as `data:` URLs its policy allows. Latin only, as each
/// page carries them: other scripts use the system's fonts as before.
fn meter_fonts_style() -> &'static str {
    static STYLE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    STYLE.get_or_init(|| {
        let pretendard = base64(include_bytes!("fonts/PretendardLatin.woff2"));
        let saira = base64(include_bytes!("fonts/Saira.woff2"));
        let face = |family: &str, data: &str, extra: &str| {
            format!("@font-face{{font-family:\"{family}\";src:url(data:font/woff2;base64,{data}) format(\"woff2\");{extra}}}")
        };
        let text = "font-weight:45 920;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2190-2199,U+2212,U+2215;";
        let narrow = "font-weight:100 900;font-stretch:50% 125%;";
        format!(
            "<style>{}{}{}</style>",
            face("Pretendard", &pretendard, text),
            face("Segoe UI", &pretendard, text),
            face("Bahnschrift", &saira, narrow),
        )
    })
}

/// A plugin page with the meter's fonts at the start of its head.
fn with_meter_fonts(page: &str) -> String {
    let at = page
        .to_ascii_lowercase()
        .find("<head")
        .and_then(|i| page[i..].find('>').map(|j| i + j + 1))
        .unwrap_or(0);
    format!("{}{}{}", &page[..at], meter_fonts_style(), &page[at..])
}

fn inlined_policy(id: &str, hashes: &[String], icons: bool) -> String {
    let scripts: String = hashes.iter().map(|h| format!(" 'sha256-{h}'")).collect();
    let own = if valid_id(id) { format!("a2plugin://localhost/{id}/") } else { "'none'".into() };
    let cdn = if icons { format!(" {}", bundled::ICON_CDN) } else { String::new() };
    format!(
        "default-src 'none'; script-src{}; style-src 'unsafe-inline'; img-src {own} data:{cdn}; font-src {own} data:; \
         connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
        if scripts.is_empty() { " 'none'".to_string() } else { scripts }
    )
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{base64, content_policy, inline_page, inlined_policy, with_meter_fonts, take_ready};
    use super::{Pending, SETTLE};
    use std::time::{Duration, Instant};

    /// Every module that comes with the app loads: its manifest, permissions
    /// and decoders read as the host reads them at start.
    #[test]
    fn every_bundled_plugin_loads() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("bundled-plugins");
        let mut ids = Vec::new();
        for entry in std::fs::read_dir(&root).unwrap() {
            let dir = entry.unwrap().path();
            if !dir.is_dir() {
                continue;
            }
            let loaded = super::load_folder(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
            assert_eq!(Some(loaded.manifest.id.as_str()), dir.file_name().and_then(|n| n.to_str()), "folder named after its id");
            ids.push(loaded.manifest.id);
        }
        for id in ["alt-roster", "boss-telegraph", "heal-alert", "pet-souls", "ping"] {
            assert!(ids.iter().any(|x| x == id), "{id} is bundled");
        }
    }

    /// Linux plugin pages get the meter's fonts, inside their head, under
    /// the names plugins use.
    #[test]
    fn plugin_pages_carry_the_meter_fonts_in_their_head() {
        let page = with_meter_fonts("<!doctype html><html><head><title>x</title></head><body></body></html>");
        let head = page.find("<head>").unwrap() + "<head>".len();
        assert!(page[head..].starts_with("<style>@font-face{font-family:\"Pretendard\""), "{}", &page[..200]);
        for family in ["Segoe UI", "Bahnschrift"] {
            assert!(page.contains(&format!("font-family:\"{family}\"")), "{family}");
        }
        assert!(page.ends_with("<title>x</title></head><body></body></html>"));
        // No head: at the start.
        assert!(with_meter_fonts("<p>hi</p>").starts_with("<style>"));
    }

    #[test]
    fn a_page_gets_its_own_scripts_styles_and_images_inlined() {
        let dir = std::env::temp_dir().join(format!("a2plugin-inline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("plugin")).unwrap();
        std::fs::write(dir.join("plugin/plugin.js"), "go('</script>');").unwrap();
        std::fs::write(dir.join("plugin/style.css"), "body{color:red}").unwrap();
        std::fs::write(dir.join("plugin/dot.png"), [1u8, 2, 3]).unwrap();
        std::fs::write(dir.join("secret.js"), "nope").unwrap();
        let root = dir.join("plugin").canonicalize().unwrap();
        let html = concat!(
            "<link rel=\"stylesheet\" href=\"style.css\" />",
            "<script src=\"/_sdk/a2.js\"></script>",
            "<script src=\"plugin.js\"></script>",
            "<script src=\"../secret.js\"></script>",
            "<script src=\"https://example.com/x.js\"></script>",
            "<img alt=\"\" src=\"dot.png\">",
        );
        let (page, hashes) = inline_page(html, &root, &root);
        assert!(page.contains("<style>body{color:red}</style>"), "{page}");
        assert!(page.contains("window.a2 = Object.freeze"), "the SDK");
        assert!(page.contains("<script>go('<\\/script>');</script>"), "{page}");
        assert!(page.contains("src=\"data:image/png;base64,AQID\""), "{page}");
        // Outside the folder or elsewhere: left as a tag, which the policy refuses.
        assert!(page.contains("<script src=\"../secret.js\"></script>"));
        assert!(page.contains("https://example.com/x.js"));
        assert_eq!(hashes.len(), 2);
        let policy = inlined_policy("plugin", &hashes, false);
        assert!(policy.contains(&format!("script-src 'sha256-{}' 'sha256-{}';", hashes[0], hashes[1])), "{policy}");
        assert!(policy.contains("connect-src 'none'"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_of_a_sha256() {
        use sha2::Digest;
        // printf abc | sha256sum | xxd -r -p | base64
        assert_eq!(base64(&sha2::Sha256::digest(b"abc")), "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
        assert_eq!(base64(b"ab"), "YWI=");
    }

    #[test]
    fn the_policy_names_the_plugins_own_files() {
        let base = if cfg!(windows) { "http://a2plugin.localhost" } else { "a2plugin://localhost" };
        let policy = content_policy("pet-souls", false);
        for directive in ["script-src", "style-src"] {
            let sources = policy.split(';').find(|d| d.trim().starts_with(directive)).unwrap();
            // Not 'self' alone: WebKit refuses everything in a sandboxed frame then.
            assert!(sources.contains(&format!("{base}/pet-souls/")), "{sources}");
            assert!(sources.contains(&format!("{base}/_sdk/a2.js")), "{sources}");
        }
        assert!(policy.contains("connect-src 'none'"));
        // A path that is not a plugin id adds no folder.
        assert!(!content_policy("../x", false).contains("/../x/"));
    }

    #[test]
    fn only_a_bundled_plugin_may_show_the_games_icons() {
        let img = |p: String| p.split(';').find(|d| d.trim().starts_with("img-src")).unwrap().to_string();
        assert!(img(content_policy("combat-assist", true)).contains(super::bundled::ICON_CDN));
        assert!(!img(content_policy("pet-souls", false)).contains("https:"));
        assert!(img(inlined_policy("combat-assist", &[], true)).contains(super::bundled::ICON_CDN));
        assert!(!content_policy("combat-assist", true).split(';').any(|d| d.contains("connect-src") && d.contains("https:")));
    }

    fn event(plugin: &str, name: &str, settle: bool, at: Instant) -> Pending {
        Pending { at, settle, read_ms: 0, plugin: plugin.into(), event: name.into(), data: serde_json::Value::Null }
    }

    fn names(events: &[Pending]) -> Vec<&str> {
        events.iter().map(|p| p.event.as_str()).collect()
    }

    /// A soul pickup (immediate) goes at once, unless the login's pet list,
    /// which waits for the character record, came before it: then it waits
    /// behind it, so the list never replaces counts the pickup already raised.
    #[test]
    fn an_immediate_event_goes_at_once_but_not_ahead_of_its_plugins_waiting_ones() {
        let now = Instant::now();
        let mut pending = vec![event("pets", "soul", false, now), event("cube", "spawn", false, now)];
        assert_eq!(names(&take_ready(&mut pending, now)), ["soul", "spawn"]);
        assert!(pending.is_empty());

        let mut pending = vec![
            event("pets", "list", true, now),
            event("pets", "soul", false, now),
            event("cube", "spawn", false, now),
        ];
        assert_eq!(names(&take_ready(&mut pending, now)), ["spawn"], "another plugin's event isn't held");
        assert_eq!(names(&pending), ["list", "soul"]);
        let later = now + SETTLE + Duration::from_millis(1);
        assert_eq!(names(&take_ready(&mut pending, later)), ["list", "soul"]);
        assert!(pending.is_empty());
    }
}
