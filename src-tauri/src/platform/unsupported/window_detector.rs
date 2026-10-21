/// No way to find the game's window here, so it is never "running". A port
/// would look for the process instead (e.g. AION2.exe under Proton in /proc).
pub fn find_aion2_window_title() -> Option<String> {
    None
}

pub fn find_aion2_window() -> bool {
    false
}

/// Nothing to watch here.
/// KDE only (see the Linux version): nothing here draws under the meter.
pub fn watch_screenshot_tool(_on_change: impl Fn(bool) + Send + Sync + 'static) {}

pub fn watch_focus(_on_change: impl Fn() + Send + Sync + 'static) -> Result<(), String> {
    Ok(())
}

pub fn is_aion2_foreground() -> bool {
    false
}

/// Nothing to list without a way to find the game.
pub fn describe_candidates() -> Vec<String> {
    Vec::new()
}

/// Where the game's window is (x, y, width, height): not knowable here.
pub fn game_rect() -> Option<(i32, i32, i32, i32)> {
    None
}

/// The app places the overlay itself here.
pub fn desktop_places_overlay() -> bool {
    false
}

/// Only KWin is told which screen the overlay goes on (see the Linux version).
pub fn set_overlay_screen(_key: &str) {}

/// The screens as the desktop names them: none here, the app's own list is used.
pub fn desktop_screens() -> Vec<(String, String, (i32, i32, i32, i32))> {
    Vec::new()
}
