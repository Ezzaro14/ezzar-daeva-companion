//! The one overlay: a transparent window covering the game's screen that
//! holds every plugin's widgets (fork). Each widget was a window of its own
//! (`widgets`), and on KDE Wayland every one of them sat in the taskbar and
//! opened wherever KWin put it, often on another screen than the game.
//!
//! `overlay.html` shows each widget's `widget.html` in a sandboxed frame,
//! placed where the player left it. Locked, the window lets every click
//! through to the game; unlocked, the widgets take clicks (an input region on
//! Linux, a pointer watch elsewhere); while the layout is edited it takes the
//! mouse everywhere, to drag the widgets about. Places are kept as fractions
//! of the screen, so a layout survives a change of resolution.
//!
//! It goes on the screen the game is on, or the one the player picked: on
//! KDE the KWin script places it (`platform::linux::focus`), elsewhere the
//! app moves it there itself.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::app::AppState;

/// The overlay's window label.
pub const LABEL: &str = "overlay";
/// The screen the player picked for it ("" for the game's).
pub const SCREEN_KEY: &str = "overlay.screen";
/// Most widgets one plugin may have open.
const MAX_WIDGETS: usize = 16;

/// The overlay's window title; KWin's rules and script know it by this.
pub fn title() -> String {
    crate::platform::kwin_rules::widget_layer_title()
}

/// An open widget: its size (CSS px), its top-left as fractions of the
/// overlay, its plugin's name and its own label (both shown while the layout
/// is edited), and the last data its plugin sent it, for a page that loads after.
#[derive(Clone)]
struct Widget {
    width: f64,
    height: f64,
    at: (f64, f64),
    title: String,
    label: String,
    /// Takes clicks even while locked.
    clickable: bool,
    last: Option<Value>,
}

type Key = (String, String);

fn widgets() -> &'static Mutex<BTreeMap<Key, Widget>> {
    static WIDGETS: std::sync::OnceLock<Mutex<BTreeMap<Key, Widget>>> = std::sync::OnceLock::new();
    WIDGETS.get_or_init(Mutex::default)
}

/// The overlay's size in CSS px and the page's scale, as the page reported.
static METRICS: Mutex<(f64, f64, f64)> = Mutex::new((0.0, 0.0, 1.0));

/// Where the overlay takes the mouse: rectangles in CSS px, or everywhere.
static INPUT: Mutex<(Vec<(f64, f64, f64, f64)>, bool)> = Mutex::new((Vec::new(), false));

/// No input region here (Windows): the pointer watch lets clicks through.
static WATCHING: AtomicBool = AtomicBool::new(false);

/// The meter is hidden because the game is not in front (Hide when AION2
/// isn't focused): the plugins set to hide with it hide too.
static UNFOCUSED: AtomicBool = AtomicBool::new(false);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn place_key(id: &str, name: &str) -> String {
    format!("overlay.widget.{id}.{name}")
}

fn saved_place(app: &tauri::AppHandle, id: &str, name: &str) -> Option<(f64, f64)> {
    let value = app.try_state::<AppState>()?.settings.get(&place_key(id, name))?;
    let (x, y) = value.split_once(',')?;
    let (x, y): (f64, f64) = (x.trim().parse().ok()?, y.trim().parse().ok()?);
    (x.is_finite() && y.is_finite()).then_some((x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)))
}

/// The overlay's size in CSS px: as its page said, or the primary screen's
/// until it has.
fn size(app: &tauri::AppHandle) -> (f64, f64) {
    let (w, h, _) = *lock(&METRICS);
    if w > 0.0 && h > 0.0 {
        return (w, h);
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let s = m.size().to_logical::<f64>(m.scale_factor());
            (s.width, s.height)
        })
        .unwrap_or((1920.0, 1080.0))
}

/// Where a widget goes the first time: the bundled ones each have a spot
/// (`bundled::default_place`: centre x, top y); any other in a column down
/// the right, below what is there.
fn first_place(app: &tauri::AppHandle, id: &str, name: &str, width: f64, height: f64) -> (f64, f64) {
    let (sw, sh) = size(app);
    let (fx, fy) = super::bundled::default_place(id, name).unwrap_or_else(|| {
        let n = lock(widgets()).len() as f64;
        (0.8, (0.12 + 0.07 * n) % 0.8)
    });
    let left = (fx - width / 2.0 / sw).clamp(0.0, (1.0 - width / sw).max(0.0));
    let top = fy.clamp(0.0, (1.0 - height / sh).max(0.0));
    (left, top)
}

fn widget_json(id: &str, name: &str, w: &Widget) -> Value {
    serde_json::json!({
        "plugin": id, "name": name, "title": w.title, "label": w.label, "clickable": w.clickable,
        "width": w.width, "height": w.height, "x": w.at.0, "y": w.at.1,
    })
}

/// Tell the overlay's page something (`op`: open, close, send, place, state).
fn tell(app: &tauri::AppHandle, op: Value) {
    let _ = app.emit_to(LABEL, "overlay", op);
}

/// Whether a plugin's widgets are locked (its own lock, or the dashboard's
/// for all).
fn is_locked(app: &tauri::AppHandle, id: &str) -> bool {
    super::widgets::locked(app, id)
}

/// Everything the page needs to draw the widgets as they should be now.
fn state(app: &tauri::AppHandle) -> Value {
    let editing = super::bundled::editing();
    let ids: Vec<String> = {
        let mut ids: Vec<String> = lock(widgets()).keys().map(|(id, _)| id.clone()).collect();
        ids.dedup();
        ids
    };
    let unfocused = UNFOCUSED.load(Ordering::Relaxed);
    let hidden_plugins: Vec<&String> = ids
        .iter()
        .filter(|id| super::game_hides(app, id) || (unfocused && super::hides_unfocused(app, &format!("plugin-{id}"))))
        .collect();
    let locked: serde_json::Map<String, Value> = ids.iter().map(|id| (id.clone(), Value::Bool(is_locked(app, id)))).collect();
    serde_json::json!({
        "op": "state",
        "editing": editing,
        "hidden": super::bundled::all_hidden(app) && !editing,
        "hiddenPlugins": hidden_plugins,
        "locked": locked,
        "screenshot": crate::app::screenshot_tool_in_front(),
    })
}

/// Tell the page how things are now (lock, editing, hidden).
pub fn refresh(app: &tauri::AppHandle) {
    tell(app, state(app));
}

/// The meter hid because the game isn't in front, or came back.
pub fn set_unfocused(app: &tauri::AppHandle, unfocused: bool) {
    if UNFOCUSED.swap(unfocused, Ordering::Relaxed) != unfocused {
        refresh(app);
    }
}

/// Make the overlay window, once, at start: on the game's screen and letting
/// every click through until its page says where its widgets are.
pub fn ensure(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let (width, height) = size(app);
    let title = title();
    crate::app::note_window_title(&title, LABEL);
    let front = crate::platform::window::front_window();
    let window = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("overlay.html".into()))
        .title(title)
        .inner_size(width, height)
        .position(0.0, 0.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // KWin sizes it to the game's screen, which a fixed size would refuse.
        .resizable(true)
        .focused(false)
        .focusable(false)
        .build()
        .map_err(|e| e.to_string())?;
    crate::platform::window::never_activate(&window, front);
    // Asked again once it exists: GTK can drop hints given before mapping.
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);
    if let Some(state) = app.try_state::<AppState>() {
        crate::platform::window_detector::set_overlay_screen(&state.settings.get(SCREEN_KEY).unwrap_or_default());
    }
    fit(app);
    // Click-through from the start, before its page says where its widgets
    // are (or if it never does): an input region needs the window on screen,
    // so once it is, and again a moment later.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for wait in [300, 1500] {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                if let Some(window) = app.get_webview_window(LABEL) {
                    apply_input(&app, &window);
                }
            });
        }
    });
    Ok(window)
}

/// Cover the screen the game is on, or the one picked, where the app places
/// its own windows (not on KDE, where KWin does: see the module docs).
/// Without the game: the meter's screen, then the primary one.
pub fn fit(app: &tauri::AppHandle) {
    if crate::platform::window_detector::desktop_places_overlay() {
        return;
    }
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let monitors = app.available_monitors().unwrap_or_default();
    let picked = app.try_state::<AppState>().and_then(|s| s.settings.get(SCREEN_KEY)).unwrap_or_default();
    let contains = |m: &tauri::Monitor, x: i32, y: i32| {
        let (p, s) = (m.position(), m.size());
        x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
    };
    let monitor = monitors
        .iter()
        .find(|m| !picked.is_empty() && m.name().is_some_and(|n| *n == picked))
        .cloned()
        .or_else(|| {
            let (x, y, w, h) = crate::platform::window_detector::game_rect()?;
            monitors.iter().find(|m| contains(m, x + w / 2, y + h / 2)).cloned()
        })
        .or_else(|| app.get_webview_window("main")?.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let (at, size) = (*monitor.position(), *monitor.size());
    if window.outer_position().ok() != Some(at) {
        let _ = window.set_position(at);
    }
    if window.outer_size().ok() != Some(size) {
        let _ = window.set_size(size);
    }
}

/// The screens to pick from: the desktop's (KWin), or the app's own list.
/// Each `{ key, label, width, height }`.
#[tauri::command]
pub fn overlay_screens(app: tauri::AppHandle) -> Value {
    let desktop = crate::platform::window_detector::desktop_screens();
    let list: Vec<Value> = if desktop.is_empty() {
        app.available_monitors()
            .unwrap_or_default()
            .iter()
            .filter_map(|m| {
                let name = m.name()?.clone();
                Some(serde_json::json!({ "key": name, "label": "", "width": m.size().width, "height": m.size().height }))
            })
            .collect()
    } else {
        desktop
            .into_iter()
            .map(|(key, label, (_, _, w, h))| serde_json::json!({ "key": key, "label": label, "width": w, "height": h }))
            .collect()
    };
    let picked = app.try_state::<AppState>().and_then(|s| s.settings.get(SCREEN_KEY)).unwrap_or_default();
    serde_json::json!({ "screens": list, "picked": picked })
}

/// Put the overlay on screen `key`, or "" for the game's.
#[tauri::command]
pub fn overlay_set_screen(app: tauri::AppHandle, key: String) {
    let key: String = key.chars().take(128).collect();
    if let Some(state) = app.try_state::<AppState>() {
        state.settings.set(SCREEN_KEY, &key);
    }
    crate::platform::window_detector::set_overlay_screen(&key);
    fit(&app);
}

// ── Widgets, as plugins ask (see `widgets`) ─────────────────────────────────

/// Open widget `name` of plugin `id`, or size it again if it is open.
pub fn open(app: &tauri::AppHandle, id: &str, name: &str, width: f64, height: f64, label: &str, clickable: bool) -> Result<(), String> {
    ensure(app)?;
    let key = (id.to_string(), name.to_string());
    let widget = {
        let mut all = lock(widgets());
        if !all.contains_key(&key) && all.keys().filter(|(owner, _)| owner == id).count() >= MAX_WIDGETS {
            return Err(format!("at most {MAX_WIDGETS} widgets"));
        }
        if let Some(w) = all.get_mut(&key) {
            w.width = width;
            w.height = height;
            if !label.is_empty() {
                w.label = label.to_string();
            }
            w.clickable = clickable;
            w.clone()
        } else {
            drop(all);
            let plugin_name = super::host(app)?.with(id, |l| l.manifest.name.clone()).ok_or("no such plugin")?;
            let at = saved_place(app, id, name).unwrap_or_else(|| first_place(app, id, name, width, height));
            let w = Widget { width, height, at, title: plugin_name, label: label.to_string(), clickable, last: None };
            lock(widgets()).insert(key.clone(), w.clone());
            w
        }
    };
    let mut op = widget_json(id, name, &widget);
    op["op"] = "open".into();
    tell(app, op);
    refresh(app);
    Ok(())
}

pub fn close(app: &tauri::AppHandle, id: &str, name: &str) {
    if lock(widgets()).remove(&(id.to_string(), name.to_string())).is_some() {
        tell(app, serde_json::json!({ "op": "close", "plugin": id, "name": name }));
    }
}

/// Close every widget of plugin `id` (its window closed, or it stopped).
pub fn close_plugin(app: &tauri::AppHandle, id: &str) {
    let names: Vec<String> = lock(widgets()).keys().filter(|(owner, _)| owner == id).map(|(_, n)| n.clone()).collect();
    for name in names {
        close(app, id, &name);
    }
}

pub fn send(app: &tauri::AppHandle, id: &str, name: &str, data: Value) -> Result<(), String> {
    match lock(widgets()).get_mut(&(id.to_string(), name.to_string())) {
        Some(w) => w.last = Some(data.clone()),
        None => return Ok(()),
    }
    tell(app, serde_json::json!({ "op": "send", "plugin": id, "name": name, "data": data }));
    Ok(())
}

/// Where widget `name` of plugin `id` is: physical pixels from the overlay's
/// top left, and the overlay as its `screen`; null when it is not open.
pub fn where_is(app: &tauri::AppHandle, id: &str, name: &str) -> Value {
    let Some(w) = lock(widgets()).get(&(id.to_string(), name.to_string())).cloned() else { return Value::Null };
    let (sw, sh) = size(app);
    let scale = lock(&METRICS).2.max(0.1);
    let px = |v: f64| (v * scale).round() as i64;
    serde_json::json!({
        "x": px(w.at.0 * sw), "y": px(w.at.1 * sh), "width": px(w.width), "height": px(w.height),
        "screen": { "x": 0, "y": 0, "width": px(sw), "height": px(sh) },
    })
}

/// Move widget `name` of plugin `id` to `x, y`, physical pixels from the
/// overlay's top left (as `where_is` gives them). Kept for when it opens.
pub fn place(app: &tauri::AppHandle, id: &str, name: &str, x: i32, y: i32) {
    let (sw, sh) = size(app);
    let scale = lock(&METRICS).2.max(0.1);
    let at = ((f64::from(x) / scale / sw).clamp(0.0, 1.0), (f64::from(y) / scale / sh).clamp(0.0, 1.0));
    if let Some(state) = app.try_state::<AppState>() {
        state.settings.set(&place_key(id, name), &format!("{:.5},{:.5}", at.0, at.1));
    }
    if let Some(w) = lock(widgets()).get_mut(&(id.to_string(), name.to_string())) {
        w.at = at;
    }
    tell(app, serde_json::json!({ "op": "place", "plugin": id, "name": name, "x": at.0, "y": at.1 }));
}

/// Whether any widget is on screen to be clicked (unlocked, not hidden).
pub fn any_unlocked_shown(app: &tauri::AppHandle) -> bool {
    if super::bundled::all_hidden(app) {
        return false;
    }
    let ids: Vec<String> = lock(widgets()).keys().map(|(id, _)| id.clone()).collect();
    ids.iter().any(|id| !is_locked(app, id) && !super::game_hides(app, id))
}

// ── The overlay's own page ───────────────────────────────────────────────────

fn from_overlay(window: &tauri::WebviewWindow) -> Result<(), String> {
    (window.label() == LABEL).then_some(()).ok_or_else(|| "not the overlay".to_string())
}

/// The widgets open now, how things are, and the meter's language.
#[tauri::command]
pub fn overlay_hello(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Value, String> {
    from_overlay(&window)?;
    let list: Vec<Value> = lock(widgets())
        .iter()
        .map(|((id, name), w)| {
            let mut v = widget_json(id, name, w);
            v["last"] = w.last.clone().unwrap_or(Value::Null);
            v
        })
        .collect();
    let language = app.try_state::<AppState>().and_then(|s| s.settings.get("dpsMeter.language")).unwrap_or_else(|| "en".into());
    Ok(serde_json::json!({ "widgets": list, "state": state(&app), "language": language }))
}

/// The page's size in CSS px and its scale, at load and on each resize.
#[tauri::command]
pub fn overlay_metrics(window: tauri::WebviewWindow, width: f64, height: f64, scale: f64) -> Result<(), String> {
    from_overlay(&window)?;
    let ok = |v: f64| v.is_finite() && v > 0.0 && v < 100_000.0;
    if ok(width) && ok(height) && ok(scale) {
        *lock(&METRICS) = (width, height, scale);
    }
    Ok(())
}

/// Where the overlay takes the mouse now: `rects` (CSS px, the widgets
/// that may be clicked), or everywhere with `all` (editing the layout).
#[tauri::command]
pub fn overlay_input(app: tauri::AppHandle, window: tauri::WebviewWindow, rects: Vec<(f64, f64, f64, f64)>, all: bool) -> Result<(), String> {
    from_overlay(&window)?;
    let shot = crate::app::screenshot_tool_in_front();
    let rects: Vec<_> = if shot {
        Vec::new()
    } else {
        rects.into_iter().filter(|r| [r.0, r.1, r.2, r.3].iter().all(|v| v.is_finite())).take(256).collect()
    };
    let all = all && !shot;
    *lock(&INPUT) = (rects.clone(), all);
    apply_input(&app, &window);
    Ok(())
}

fn apply_input(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let (rects, all) = lock(&INPUT).clone();
    let scale = lock(&METRICS).2;
    if crate::platform::window::take_mouse_over(window, &rects, scale, all) {
        return;
    }
    if !WATCHING.swap(true, Ordering::Relaxed) {
        watch_pointer(app.clone());
    }
}

/// Where there is no input region (Windows): look where the pointer is,
/// and let the clicks through unless it is over a widget that takes them.
fn watch_pointer(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            let Some(window) = app.get_webview_window(LABEL) else { continue };
            let (rects, all) = lock(&INPUT).clone();
            let ignore = if all {
                false
            } else if rects.is_empty() {
                true
            } else {
                let over = (|| {
                    let (cx, cy) = crate::platform::window::cursor_position()?;
                    let at = window.outer_position().ok()?;
                    let scale = window.scale_factor().ok()?;
                    let (x, y) = (f64::from(cx - at.x) / scale, f64::from(cy - at.y) / scale);
                    Some(rects.iter().any(|&(rx, ry, rw, rh)| x >= rx && y >= ry && x < rx + rw && y < ry + rh))
                })();
                !over.unwrap_or(false)
            };
            if ignoring != Some(ignore) && window.set_ignore_cursor_events(ignore).is_ok() {
                ignoring = Some(ignore);
            }
        }
    });
}

/// Click-through as it should be again (a screenshot tool came or went).
pub fn reapply_input(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        refresh(app);
        apply_input(app, &window);
    }
}

/// The player moved a widget (`x, y`: its top left as fractions of the
/// overlay): kept, and its plugin told ("widget-moved", physical pixels as
/// `where_is` gives them), which may lay its other widgets out around it.
#[tauri::command]
pub fn overlay_moved(app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: String, name: String, x: f64, y: f64) -> Result<(), String> {
    from_overlay(&window)?;
    if !(x.is_finite() && y.is_finite()) {
        return Err("not a place".into());
    }
    let at = (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0));
    match lock(widgets()).get_mut(&(plugin.clone(), name.clone())) {
        Some(w) => w.at = at,
        None => return Ok(()),
    }
    if let Some(state) = app.try_state::<AppState>() {
        state.settings.set(&place_key(&plugin, &name), &format!("{:.5},{:.5}", at.0, at.1));
    }
    let (sw, sh) = size(&app);
    let scale = lock(&METRICS).2.max(0.1);
    let data = serde_json::json!({ "name": name, "x": (at.0 * sw * scale).round(), "y": (at.1 * sh * scale).round() });
    let event = serde_json::json!({ "plugin": plugin, "event": "widget-moved", "data": data });
    super::emit_plugin(&app, &plugin, event).map_err(|e| e.to_string())
}

/// Put every widget back where it first went.
#[tauri::command]
pub fn overlay_reset_layout(app: tauri::AppHandle) {
    let keys: Vec<Key> = lock(widgets()).keys().cloned().collect();
    if let Some(state) = app.try_state::<AppState>() {
        for (key, _) in state.settings.get_all() {
            if key.starts_with("overlay.widget.") {
                state.settings.remove(&key);
            }
        }
    }
    for (id, name) in keys {
        let (w, h) = match lock(widgets()).get(&(id.clone(), name.clone())) {
            Some(w) => (w.width, w.height),
            None => continue,
        };
        let at = first_place(&app, &id, &name, w, h);
        if let Some(widget) = lock(widgets()).get_mut(&(id.clone(), name.clone())) {
            widget.at = at;
        }
        tell(&app, serde_json::json!({ "op": "place", "plugin": id, "name": name, "x": at.0, "y": at.1 }));
    }
}

/// A widget's message to its plugin, heard there as "widget-message":
/// `{ name, data }`.
#[tauri::command]
pub fn overlay_post(app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: String, name: String, data: Value) -> Result<(), String> {
    from_overlay(&window)?;
    if !lock(widgets()).contains_key(&(plugin.clone(), name.clone())) {
        return Err("no such widget".into());
    }
    if data.to_string().len() > super::widgets::MAX_MESSAGE {
        return Err("message too large".into());
    }
    let event = serde_json::json!({ "plugin": plugin, "event": "widget-message", "data": { "name": name, "data": data } });
    super::emit_plugin(&app, &plugin, event).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_overlay_is_titled_as_an_icon_so_it_never_takes_focus() {
        let title = super::title();
        assert!(title.contains(crate::platform::kwin_rules::ICON_TITLE_MARK), "{title}");
        assert!(title.starts_with(crate::fork::APP_NAME));
    }
}
