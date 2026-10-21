use std::path::{Path, PathBuf};

/// No screenshots on this platform: nothing captured, nothing saved.
#[allow(clippy::too_many_arguments)]
pub fn capture(
    _caller: &tauri::WebviewWindow,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
    _scale: f64,
    _meter: Option<&tauri::WebviewWindow>,
    _png_path: Option<&Path>,
) -> (bool, bool) {
    (false, false)
}

pub fn default_folder() -> Option<PathBuf> {
    None
}

pub fn pick_folder(_owner: &tauri::WebviewWindow, _start_in: Option<&str>) -> Option<String> {
    None
}

/// No screen to read here.
pub fn game_corner() -> Result<crate::platform::screenshot::GameCorner, String> {
    Err("Reading the minimap works on Windows and on KDE Plasma".into())
}

/// Only Linux reads the minimap in a helper process (see the Linux version).
pub fn run_minimap_helper() -> i32 {
    2
}
