//! Which window is active, on KDE. Wayland tells no application about another
//! application's windows, but KWin runs scripts and a script can call D-Bus:
//! the one loaded here tells the meter each time the active window changes,
//! for "Hide when AION2 isn't focused". Other desktops are not covered.
//!
//! On Wayland it also keeps the meter's windows where they were left (#76):
//! no application may place its own windows there, but a KWin script may.
//! The script reports where each of the meter's windows was moved or resized
//! to, and puts each back there when it appears again.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

const SERVICE: &str = "app.ezzar.DaevaCompanion";
const PATH: &str = "/Focus";
/// The script's name in KWin, so a script left by an earlier run is replaced.
const PLUGIN: &str = "daeva-companion-focus";

/// Values are passed as strings: KWin hands JavaScript numbers to D-Bus as
/// doubles, which an integer argument would refuse. KWin 6 has
/// `windowActivated` and `windowAdded`, KWin 5 `clientActivated` and
/// `clientAdded`. `__PID__` is the meter's process id: only its windows are
/// placed.
const SCRIPT: &str = r#"// Ezzar's Daeva Companion: tells the meter which window is active, so it can hide
// while the game is not in front, and keeps the meter's own windows where
// they were left. Loaded by the meter at each start.
var SERVICE = "app.ezzar.DaevaCompanion", PATH = "/Focus", IFACE = "app.ezzar.DaevaCompanion.Focus";
var MY_PID = __PID__;
function report(w) {
    callDBus(SERVICE, PATH, IFACE, "Active",
             w ? String(w.pid) : "0", w ? String(w.resourceClass) : "", w ? String(w.caption) : "");
}
function mine(w) {
    return !!w && Number(w.pid) === MY_PID;
}
// A plugin's widget (an alert's icon), titled "<plugin> · <name>".
function widget(w) {
    return mine(w) && String(w.caption).indexOf(" · ") >= 0;
}
// The last window not ours to be active, and our widgets that just appeared:
// Wayland activates a new window, so each icon an alert opened took the
// focus from the game (a tester, mid-PvP, 2026-10-17). An icon activated
// because it appeared hands the focus straight back; one clicked keeps it.
var lastOther = null;
var fresh = [];
// The active window and the one before it. KWin activates a new window
// before it announces it (windowActivated, then windowAdded: seen on KDE
// Plasma 6, 2026-10-19), so an icon is already active when follow() meets it.
var current = null, previous = null;
function activate(w) {
    if (workspace.windowActivated) workspace.activeWindow = w;
    else workspace.activeClient = w;
}
function onActivated(w) {
    if (w !== current) {
        previous = current;
        current = w;
    }
    if (w && !mine(w)) lastOther = w;
    var i = fresh.indexOf(w);
    if (i >= 0) {
        fresh.splice(i, 1);
        if (lastOther) {
            activate(lastOther);
            return;
        }
    }
    report(w);
}
function remember(w) {
    var g = w.frameGeometry;
    callDBus(SERVICE, PATH, IFACE, "Geometry", String(w.caption), String(Math.round(g.x)), String(Math.round(g.y)),
             String(Math.round(g.width)), String(Math.round(g.height)));
}
function onScreen(r) {
    var area = workspace.virtualScreenGeometry;
    if (!area) return true;
    // Enough of its top edge on screen to be seen and dragged back.
    return r.x + 48 <= area.x + area.width && r.x + r.width >= area.x + 48
        && r.y >= area.y - 8 && r.y + 32 <= area.y + area.height;
}
// How long a window is held at its place: the meter sizes its windows to
// their content just after they appear, and KWin keeps a resized window's
// centre where it was, so the overlay, 300 px tall at first, came down
// 120 px once it shrank to its rows (a CachyOS player, 2026-10-19).
var HOLD_MS = 4000;
function place(w) {
    callDBus(SERVICE, PATH, IFACE, "Placement", String(w.caption), function (answer) {
        var p = String(answer).split(",").map(Number);
        if (p.length !== 4 || p.some(isNaN)) return;
        var g = w.frameGeometry;
        // A width or height of 0: the window keeps its own size.
        var r = { x: p[0], y: p[1], width: p[2] > 0 ? p[2] : g.width, height: p[3] > 0 ? p[3] : g.height };
        if (!onScreen(r)) return;
        w.frameGeometry = r;
        // Moved by a resize while held: back to its place, at its new size.
        // Never against the player's own move or resize.
        var until = Date.now() + HOLD_MS;
        var held = false;
        if (w.interactiveMoveResizeStarted) w.interactiveMoveResizeStarted.connect(function () { until = 0; });
        else if (w.clientStartUserMovedResized) w.clientStartUserMovedResized.connect(function () { until = 0; });
        w.frameGeometryChanged.connect(function () {
            if (held || Date.now() > until || w.move || w.resize) return;
            var now = w.frameGeometry;
            if (Math.round(now.x) === r.x && Math.round(now.y) === r.y) return;
            held = true;
            w.frameGeometry = { x: r.x, y: r.y, width: now.width, height: now.height };
            held = false;
        });
    });
}
// The one overlay (plugins::overlay): it covers the screen the game is on, or
// the one the player chose, and follows the game to another.
var OVERLAY = "__OVERLAY__", METER = "__METER__";
function isOverlay(w) {
    return mine(w) && String(w.caption) === OVERLAY;
}
function isGame(w) {
    if (!w || mine(w)) return false;
    return String(w.caption).indexOf("AION2") === 0 || String(w.resourceClass).toLowerCase() === "aion2.exe";
}
function windows() {
    return workspace.windowList ? workspace.windowList() : workspace.clientList();
}
function find(test) {
    var list = windows();
    for (var i = 0; i < list.length; i++) if (test(list[i])) return list[i];
    return null;
}
// KWin 6 names its screens (Output.name, "DP-1"); KWin 5 numbers them.
function screens() {
    if (workspace.screens) {
        return workspace.screens.map(function (o) {
            return { key: String(o.name), label: [o.manufacturer, o.model].filter(Boolean).join(" "),
                     area: workspace.clientArea(KWin.FullScreenArea, o, workspace.currentDesktop) };
        });
    }
    var out = [];
    for (var i = 0; i < workspace.numScreens; i++) {
        out.push({ key: "screen-" + (i + 1), label: "", area: workspace.clientArea(KWin.FullScreenArea, i, workspace.currentDesktop) });
    }
    return out;
}
function reportScreens() {
    var clean = function (s) { return String(s).replace(/[,;]/g, " "); };
    callDBus(SERVICE, PATH, IFACE, "Screens", screens().map(function (s) {
        var a = s.area;
        return [clean(s.key), clean(s.label), Math.round(a.x), Math.round(a.y), Math.round(a.width), Math.round(a.height)].join(",");
    }).join(";"));
}
function fit() {
    var o = find(isOverlay);
    if (!o) return;
    callDBus(SERVICE, PATH, IFACE, "OverlayScreen", function (answer) {
        var want = String(answer || ""), area = null;
        if (want) screens().forEach(function (s) { if (s.key === want) area = s.area; });
        var game = area ? null : find(isGame);
        if (game) area = workspace.clientArea(KWin.FullScreenArea, game);
        var meter = area ? null : find(function (w) { return mine(w) && String(w.caption) === METER; });
        if (meter) area = workspace.clientArea(KWin.FullScreenArea, meter);
        if (!area) return;
        var g = o.frameGeometry;
        if (Math.round(g.x) === Math.round(area.x) && Math.round(g.y) === Math.round(area.y)
            && Math.round(g.width) === Math.round(area.width) && Math.round(g.height) === Math.round(area.height)) return;
        o.frameGeometry = { x: area.x, y: area.y, width: area.width, height: area.height };
    });
}
// Where the game's picture is (without its window's frame), for reading its
// minimap; "" once it is gone.
function reportGame(w) {
    var g = w ? (w.clientGeometry || w.frameGeometry) : null;
    callDBus(SERVICE, PATH, IFACE, "Game", g ? [Math.round(g.x), Math.round(g.y), Math.round(g.width), Math.round(g.height)].join(",") : "");
}
function follow(w) {
    if (isGame(w)) {
        w.frameGeometryChanged.connect(fit);
        w.frameGeometryChanged.connect(function () { reportGame(w); });
        fit();
        reportGame(w);
        return;
    }
    if (!mine(w)) return;
    // The overlay, its widgets and the meter stay off the taskbar: only the
    // dashboard and the meter's tool windows are listed there. GTK's own
    // request for that is X11's alone.
    if (widget(w) || String(w.caption) === METER) {
        w.skipTaskbar = true;
        w.skipSwitcher = true;
        w.skipPager = true;
    }
    if (isOverlay(w)) {
        fit();
        return;
    }
    // An icon already active as it is added: KWin activated it first. The
    // focus goes back to the window active before it. (The KWin rule for
    // icons keeps them from taking it at all; this is for when the rule is
    // missing, as KWin can lose it.)
    var aw = workspace.activeWindow || workspace.activeClient;
    if (widget(w) && aw === w && previous && previous !== w && !previous.deleted) activate(previous);
    else if (widget(w)) {
        fresh.push(w);
        if (fresh.length > 32) fresh.shift();
    }
    var done = w.interactiveMoveResizeFinished || w.clientFinishUserMovedResized;
    if (done) done.connect(function () { remember(w); });
    place(w);
}
if (workspace.windowActivated) {
    workspace.windowActivated.connect(onActivated);
    report(workspace.activeWindow);
    workspace.windowAdded.connect(follow);
    workspace.windowRemoved.connect(function (w) { if (isGame(w)) reportGame(null); });
    workspace.windowList().forEach(follow);
    workspace.screensChanged.connect(function () { reportScreens(); fit(); });
} else {
    workspace.clientActivated.connect(onActivated);
    report(workspace.activeClient);
    workspace.clientAdded.connect(follow);
    workspace.clientRemoved.connect(function (w) { if (isGame(w)) reportGame(null); });
    workspace.clientList().forEach(follow);
    workspace.numberScreensChanged.connect(function () { reportScreens(); fit(); });
}
reportScreens();
"#;

/// A window's place and size, as KWin gives them: x, y, width, height.
pub type Rect = (i32, i32, i32, i32);

/// Where the meter keeps the places KWin reports, by window title.
pub struct Places {
    pub save: Box<dyn Fn(&str, Rect) + Send + Sync>,
    pub load: Box<dyn Fn(&str) -> Option<Rect> + Send + Sync>,
}

static PLACES: OnceLock<Places> = OnceLock::new();

/// Keep the meter's windows where they were left, through KWin (#76). Only
/// on Wayland: under X11 the meter places its own windows, as on Windows.
pub fn keep_places(places: Places) {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var("GDK_BACKEND").map_or(true, |b| !b.starts_with("x11"));
    if wayland {
        let _ = PLACES.set(places);
    }
}

/// 0: not known (no report yet, or not KDE). 1: the game or one of the
/// meter's own windows is active. 2: something else is.
static ACTIVE: AtomicU8 = AtomicU8::new(0);

/// The game's window has been reported active at least once. Until then the
/// reports are not trusted: the setting is on by default, and a game window
/// this does not recognise must not leave the meter hidden for good.
static SEEN_GAME: AtomicBool = AtomicBool::new(false);

/// The connection that serves `Focus`; dropped, the service would go away.
static CONNECTION: OnceLock<zbus::blocking::Connection> = OnceLock::new();

/// Told when the game or the meter gains or loses the front.
static ON_CHANGE: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// Whether a screenshot tool (Spectacle) is the active window, and who is
/// told when that changes (`watch_screenshot_tool`).
static SCREENSHOT: AtomicBool = AtomicBool::new(false);
static ON_SCREENSHOT: OnceLock<Box<dyn Fn(bool) + Send + Sync>> = OnceLock::new();

/// The screen the player chose for the overlay ("" for the game's), and
/// the screens KWin reported: (key, label, x, y, width, height).
static OVERLAY_SCREEN: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static SCREENS: std::sync::Mutex<Vec<Screen>> = std::sync::Mutex::new(Vec::new());
/// Where the game's picture is, as KWin last said.
static GAME: std::sync::Mutex<Option<Rect>> = std::sync::Mutex::new(None);
/// The script is running, so KWin places the overlay.
static SCRIPT_RUNNING: AtomicBool = AtomicBool::new(false);

/// A screen as KWin names it: its key (KWin 6: the output's name, "DP-1";
/// KWin 5: "screen-<n>"), a label (maker and model), and where it is.
pub type Screen = (String, String, (i32, i32, i32, i32));

/// Whether KWin places the overlay (the script runs).
pub fn places_overlay() -> bool {
    SCRIPT_RUNNING.load(Ordering::Relaxed)
}

/// Where the game's picture is (x, y, width, height), if KWin has said.
pub fn game_area() -> Option<Rect> {
    *GAME.lock().unwrap_or_else(|p| p.into_inner())
}

/// The screens KWin last reported.
pub fn screens() -> Vec<Screen> {
    SCREENS.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// The screen the overlay goes on, by its key ("" for the game's). KWin is
/// asked to place it again when that changes: the script runs afresh.
pub fn set_overlay_screen(key: &str) {
    let changed = {
        let mut now = OVERLAY_SCREEN.lock().unwrap_or_else(|p| p.into_inner());
        let changed = *now != key;
        *now = key.to_string();
        changed
    };
    if changed && let Some(connection) = CONNECTION.get() {
        if let Err(e) = load_script(connection) {
            tracing::warn!("KWin: could not load the script again: {e}");
        }
    }
}

fn parse_rect(text: &str) -> Option<Rect> {
    let n: Vec<i32> = text.split(',').map(|v| v.trim().parse().ok()).collect::<Option<_>>()?;
    let [x, y, w, h] = n[..] else { return None };
    (w > 0 && h > 0).then_some((x, y, w, h))
}

fn parse_screens(list: &str) -> Vec<Screen> {
    list.split(';')
        .filter_map(|item| {
            let parts: Vec<&str> = item.split(',').collect();
            let [key, label, x, y, w, h] = parts[..] else { return None };
            let n = |v: &str| v.trim().parse::<i32>().ok();
            Some((key.to_string(), label.trim().to_string(), (n(x)?, n(y)?, n(w)?, n(h)?)))
        })
        .filter(|(key, _, (_, _, w, h))| !key.is_empty() && *w > 0 && *h > 0)
        .collect()
}

/// Be told when a screenshot tool becomes, or stops being, the active window.
pub fn watch_screenshot_tool(on_change: impl Fn(bool) + Send + Sync + 'static) {
    let _ = ON_SCREENSHOT.set(Box::new(on_change));
}

/// KDE's Spectacle, by its window class (Plasma 6: `org.kde.spectacle`,
/// Plasma 5: `spectacle`). Its area selection is drawn under the meter's
/// windows (the overlay layer, see `kwin_rules`), so they took the drag
/// (Zoe, CachyOS, 2026-10-20).
fn is_screenshot_tool(class: &str) -> bool {
    let class = class.trim().to_ascii_lowercase();
    class == "org.kde.spectacle" || class == "spectacle"
}

/// Whether the game (or the meter) is the active window, if KWin has said
/// and the game has been recognised.
pub fn game_or_meter_active() -> Option<bool> {
    if !SEEN_GAME.load(Ordering::Relaxed) {
        return None;
    }
    match ACTIVE.load(Ordering::Relaxed) {
        0 => None,
        1 => Some(true),
        _ => Some(false),
    }
}

struct Focus;

#[zbus::interface(name = "app.ezzar.DaevaCompanion.Focus")]
impl Focus {
    fn active(&self, pid: String, class: String, caption: String) {
        let shot = is_screenshot_tool(&class);
        if SCREENSHOT.swap(shot, Ordering::Relaxed) != shot {
            tracing::info!("KWin: screenshot tool {}", if shot { "in front: the meter lets clicks through" } else { "gone" });
            if let Some(on_screenshot) = ON_SCREENSHOT.get() {
                on_screenshot(shot);
            }
        }
        let who = classify(pid.parse().unwrap_or(0), &class, &caption);
        if who == Who::Game && !SEEN_GAME.swap(true, Ordering::Relaxed) {
            tracing::info!("KWin: the game's window is active (class {class:?})");
        }
        let was = ACTIVE.swap(if who == Who::Other { 2 } else { 1 }, Ordering::Relaxed);
        if was != ACTIVE.load(Ordering::Relaxed) && SEEN_GAME.load(Ordering::Relaxed) {
            if let Some(on_change) = ON_CHANGE.get() {
                on_change();
            }
        }
    }

    /// One of the meter's windows was moved or resized by the player.
    fn geometry(&self, caption: String, x: String, y: String, width: String, height: String) {
        let Some(places) = PLACES.get() else { return };
        let n = |v: &str| v.trim().parse::<i32>().ok();
        if let (Some(x), Some(y), Some(w), Some(h)) = (n(&x), n(&y), n(&width), n(&height))
            && w > 0
            && h > 0
        {
            (places.save)(&caption, (x, y, w, h));
        }
    }

    /// The screen the overlay goes on, by its key, or "" for the game's.
    fn overlay_screen(&self) -> String {
        OVERLAY_SCREEN.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Where the game's picture is, `"x,y,width,height"`, or "" once it is gone.
    fn game(&self, rect: String) {
        *GAME.lock().unwrap_or_else(|p| p.into_inner()) = parse_rect(&rect);
    }

    /// The screens, as `key,label,x,y,width,height` joined by `;`.
    fn screens(&self, list: String) {
        *SCREENS.lock().unwrap_or_else(|p| p.into_inner()) = parse_screens(&list);
    }

    /// Where one of the meter's windows belongs, `"x,y,width,height"`, or ""
    /// to leave it where KWin put it.
    fn placement(&self, caption: String) -> String {
        PLACES
            .get()
            .and_then(|places| (places.load)(&caption))
            .map(|(x, y, w, h)| format!("{x},{y},{w},{h}"))
            .unwrap_or_default()
    }
}

#[derive(Debug, PartialEq)]
enum Who {
    Game,
    Meter,
    Other,
}

/// The game by title or class, as on Windows, or by its process; the meter by
/// its own process id, so opening Settings does not hide the overlay.
fn classify(pid: u32, class: &str, caption: &str) -> Who {
    if caption.starts_with("AION2") || class.eq_ignore_ascii_case("aion2.exe") {
        return Who::Game;
    }
    if pid == 0 {
        return Who::Other;
    }
    if pid == std::process::id() {
        return Who::Meter;
    }
    let dir = std::path::PathBuf::from(format!("/proc/{pid}"));
    let comm = std::fs::read_to_string(dir.join("comm")).unwrap_or_default();
    let cmdline = std::fs::read(dir.join("cmdline")).unwrap_or_default();
    if crate::platform::procfs::is_aion2_process(&comm, &cmdline) { Who::Game } else { Who::Other }
}

/// Serve `Focus` on the session bus and load the script into KWin. Does
/// nothing outside KDE: there the game is taken as always focused.
pub fn watch(on_change: impl Fn() + Send + Sync + 'static) -> Result<(), String> {
    if !super::process::is_kde() || CONNECTION.get().is_some() {
        return Ok(());
    }
    let connection = zbus::blocking::connection::Builder::session()
        .and_then(|b| b.name(SERVICE))
        .and_then(|b| b.serve_at(PATH, Focus))
        .and_then(|b| b.build())
        .map_err(|e| format!("D-Bus service: {e}"))?;

    let id = load_script(&connection)?;
    let _ = ON_CHANGE.set(Box::new(on_change));
    let _ = CONNECTION.set(connection);
    tracing::info!("KWin reports the active window (script {id})");
    Ok(())
}

/// Write the script and have KWin run it, replacing one already running.
fn load_script(connection: &zbus::blocking::Connection) -> Result<i32, String> {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let path = dir.join("daeva-companion-focus.js");
    let js_string = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let script = SCRIPT
        .replace("__PID__", &std::process::id().to_string())
        .replace("\"__OVERLAY__\"", &js_string(&crate::platform::kwin_rules::widget_layer_title()))
        .replace("\"__METER__\"", &js_string(crate::platform::kwin_rules::OVERLAY_TITLE));
    std::fs::write(&path, script).map_err(|e| format!("writing the script: {e}"))?;

    let kwin = zbus::blocking::Proxy::new(connection, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting")
        .map_err(|e| format!("KWin scripting: {e}"))?;
    let _ = kwin.call_method("unloadScript", &(PLUGIN,));
    let id: i32 = kwin
        .call("loadScript", &(path.to_string_lossy().as_ref(), PLUGIN))
        .map_err(|e| format!("loading the script: {e}"))?;
    if id < 0 {
        return Err("KWin did not load the script".into());
    }
    kwin.call_method("start", &()).map_err(|e| format!("starting the script: {e}"))?;
    SCRIPT_RUNNING.store(true, Ordering::Relaxed);
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screens_read_back_from_the_script() {
        let list = parse_screens("DP-1,Dell U2720Q,0,0,2560,1440;HDMI-A-1,,2560,0,1920,1080;bad;,x,0,0,1,1");
        assert_eq!(list, vec![
            ("DP-1".to_string(), "Dell U2720Q".to_string(), (0, 0, 2560, 1440)),
            ("HDMI-A-1".to_string(), String::new(), (2560, 0, 1920, 1080)),
        ]);
        assert!(parse_screens("").is_empty());
    }

    #[test]
    fn the_games_place_reads_back_from_the_script() {
        assert_eq!(parse_rect("0,28,1911,1007"), Some((0, 28, 1911, 1007)));
        assert_eq!(parse_rect(""), None);
        assert_eq!(parse_rect("0,0,0,0"), None);
        assert_eq!(parse_rect("1,2,3"), None);
    }

    #[test]
    fn spectacle_is_known_by_its_class() {
        assert!(is_screenshot_tool("org.kde.spectacle"));
        assert!(is_screenshot_tool("spectacle"));
        assert!(!is_screenshot_tool("org.kde.konsole"));
        assert!(!is_screenshot_tool(""));
    }

    #[test]
    fn the_game_is_known_by_title_or_class_and_the_meter_by_itself() {
        assert_eq!(classify(0, "", "AION2"), Who::Game);
        assert_eq!(classify(0, "aion2.exe", ""), Who::Game);
        assert_eq!(classify(std::process::id(), crate::fork::BINARY, crate::fork::APP_NAME), Who::Meter);
        assert_eq!(classify(0, "firefox", "Mozilla Firefox"), Who::Other);
    }
}
