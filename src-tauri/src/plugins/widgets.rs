//! Plugin widgets (#77): small things a plugin shows over the game, such as a
//! countdown icon, which the player can drag anywhere and lock in place.
//!
//! A widget shows the plugin's `widget.html`, sandboxed like its main page.
//! The fork shows every widget of every plugin in one overlay window over the
//! game (`overlay`), not in a window each: the calls plugins make are the
//! same (`a2.widgets`, permission `widgets`), and a widget can still only ask
//! to be dragged and post a message back to its plugin (`a2.widget`). Each
//! widget remembers where it was left; locked, a plugin's widgets let clicks
//! through to the game. They close with the plugin's main window.

use serde_json::Value;
use tauri::Manager;

use super::{overlay, plugin_of, require};
use crate::app::AppState;

/// Most bytes of data a widget message may carry, either way.
pub const MAX_MESSAGE: usize = 64 * 1024;

/// The plugin and widget a window label names, if it is a widget's window.
/// Widgets have no windows of their own any more, so none is.
pub fn parse_label(label: &str) -> Option<(String, String)> {
    let (id, name) = label.strip_prefix("pw_")?.split_once('_')?;
    (super::valid_id(id) && valid_name(name)).then(|| (id.to_string(), name.to_string()))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn checked_name(name: &str) -> Result<(), String> {
    valid_name(name).then_some(()).ok_or_else(|| "a widget name is 1 to 32 lowercase letters, digits and '-'".into())
}

fn locked_key(id: &str) -> String {
    format!("dpsMeter.pluginWidgetsLocked.{id}")
}

/// Whether plugin `id`'s widgets are locked: they are until unlocked, so a
/// widget never takes clicks from the game unasked.
pub fn locked(app: &tauri::AppHandle, id: &str) -> bool {
    app.try_state::<AppState>().and_then(|s| s.settings.get(&locked_key(id))).as_deref() != Some("false")
}

/// Open widget `name` of the calling plugin, `width` x `height` CSS pixels,
/// or size it again if it is open. `label` names it while the layout is
/// edited ("Loss of control"), after the plugin's name. `clickable`: it takes
/// clicks even while locked (a list opened and closed in play); it still
/// moves only while unlocked.
#[tauri::command]
pub async fn plugin_widget_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
    width: f64,
    height: f64,
    label: Option<String>,
    clickable: Option<bool>,
    plugin: Option<String>,
) -> Result<(), String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "widgets")?;
    checked_name(&name)?;
    let size = |v: f64| if v.is_finite() { v.clamp(24.0, 800.0) } else { 64.0 };
    let label: String = label.unwrap_or_default().chars().filter(|c| !c.is_control()).take(40).collect();
    overlay::open(&app, &id, &name, size(width), size(height), label.trim(), clickable.unwrap_or(false))
}

/// Where widget `name` of the calling plugin is: `{ x, y, width, height }`
/// in physical pixels from the overlay's top left, and the overlay itself
/// as `screen`, or null when it is not open.
#[tauri::command]
pub fn plugin_widget_where(app: tauri::AppHandle, window: tauri::WebviewWindow, name: String, plugin: Option<String>) -> Result<Value, String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "widgets")?;
    Ok(overlay::where_is(&app, &id, &name))
}

/// Move widget `name` of the calling plugin to `x, y` (physical pixels, as
/// `plugin_widget_where` gives them), as a plugin that lays its widgets out
/// does. Locked or not: the lock is the player's hand off them, not the
/// plugin's. A widget not open yet opens there.
#[tauri::command]
pub fn plugin_widget_place(app: tauri::AppHandle, window: tauri::WebviewWindow, name: String, x: i32, y: i32, plugin: Option<String>) -> Result<(), String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "widgets")?;
    checked_name(&name)?;
    let far = 1_000_000;
    if !(-far..far).contains(&x) || !(-far..far).contains(&y) {
        return Err("not a place on a screen".into());
    }
    overlay::place(&app, &id, &name, x, y);
    Ok(())
}

/// Close widget `name` of the calling plugin.
#[tauri::command]
pub fn plugin_widget_close(app: tauri::AppHandle, window: tauri::WebviewWindow, name: String, plugin: Option<String>) -> Result<(), String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "widgets")?;
    overlay::close(&app, &id, &name);
    Ok(())
}

/// Hand widget `name` data from its plugin: it hears it as a "widget" event.
#[tauri::command]
pub fn plugin_widget_send(app: tauri::AppHandle, window: tauri::WebviewWindow, name: String, data: Value, plugin: Option<String>) -> Result<(), String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "widgets")?;
    if data.to_string().len() > MAX_MESSAGE {
        return Err("message too large".into());
    }
    overlay::send(&app, &id, &name, data)
}

/// Lock (clicks go through, no moving) or unlock all the calling plugin's
/// widgets. Kept across restarts.
#[tauri::command]
pub fn plugin_widgets_lock(app: tauri::AppHandle, window: tauri::WebviewWindow, locked: bool, plugin: Option<String>) -> Result<(), String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "widgets")?;
    set_locked(&app, &id, locked);
    Ok(())
}

/// Lock or unlock plugin `id`'s widgets (also the dashboard's Lock, for all).
pub fn set_locked(app: &tauri::AppHandle, id: &str, locked: bool) {
    if let Some(state) = app.try_state::<AppState>() {
        state.settings.set(&locked_key(id), if locked { "true" } else { "false" });
    }
    overlay::refresh(app);
}

/// Whether the calling plugin's widgets are locked.
#[tauri::command]
pub fn plugin_widgets_locked(app: tauri::AppHandle, window: tauri::WebviewWindow, plugin: Option<String>) -> Result<bool, String> {
    let id = plugin_of(&window, plugin)?;
    require(&app, &id, "widgets")?;
    Ok(locked(&app, &id))
}

/// Whether a widget is on screen and unlocked (so a click on it can open its
/// plugin's window): a way back to the plugins with the meter hidden.
pub fn any_unlocked_widget_shown(app: &tauri::AppHandle) -> bool {
    overlay::any_unlocked_shown(app)
}

/// Every widget's click-through as it should be (after a screenshot tool,
/// see `app::screenshot_tool_in_front`).
pub fn reapply_locks(app: &tauri::AppHandle) {
    overlay::reapply_input(app);
}

/// Close every widget of plugin `id`: its main window has gone.
pub fn close_all(app: &tauri::AppHandle, id: &str) {
    overlay::close_plugin(app, id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widget_names_are_checked() {
        assert!(!valid_name("has_underscore") && !valid_name("") && valid_name("boss-101006"));
        assert!(checked_name("Bad").is_err() && checked_name("bar-1").is_ok());
    }
}
