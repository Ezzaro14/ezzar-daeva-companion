//! Screenshots on Linux, the default Pictures folder, and the folder picker.
//!
//! Windows copies the pixels on screen. Wayland lets no app read the screen,
//! so here the page renders itself instead: WebKitGTK's snapshot of the
//! webview, cropped to the area the page asked for. It shows the meter on a
//! solid background rather than over the game behind it, which a screen copy
//! would. The folder picker is GTK's native one, which goes through the
//! desktop's portal on Wayland.
//!
//! The one read of the screen, the game's minimap corner for the World Map,
//! is KDE's: KWin's ScreenShot2 service, for the programs a desktop entry
//! lets use it (`allow_screenshots`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use gtk::prelude::*;
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

use super::dialog::on_gtk_thread;
use crate::platform::screenshot::encode_png;

/// The colour transparent parts of the page are laid on: the meter's own
/// dark backdrop, so a pasted screenshot reads as it does over the game.
const BACKDROP: [u8; 3] = [12, 14, 20];

/// Top-down RGBA rows.
struct Image {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl Image {
    fn crop(&self, left: u32, top: u32, width: u32, height: u32) -> Image {
        let left = left.min(self.width);
        let top = top.min(self.height);
        let width = width.min(self.width - left);
        let height = height.min(self.height - top);
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for row in top..top + height {
            let start = ((row * self.width + left) * 4) as usize;
            rgba.extend_from_slice(&self.rgba[start..start + (width * 4) as usize]);
        }
        Image { width, height, rgba }
    }

    /// `left` and `right` side by side, top-aligned, on the backdrop.
    fn beside(left: &Image, right: &Image) -> Image {
        const GAP: u32 = 8;
        let width = left.width + GAP + right.width;
        let height = left.height.max(right.height);
        let mut rgba = [BACKDROP[0], BACKDROP[1], BACKDROP[2], 255].repeat((width * height) as usize);
        for (img, x0) in [(left, 0), (right, left.width + GAP)] {
            for row in 0..img.height {
                let src = (row * img.width * 4) as usize;
                let dst = ((row * width + x0) * 4) as usize;
                rgba[dst..dst + (img.width * 4) as usize]
                    .copy_from_slice(&img.rgba[src..src + (img.width * 4) as usize]);
            }
        }
        Image { width, height, rgba }
    }
}

/// Cairo's ARGB32 (premultiplied, native byte order) to RGBA, laid on the
/// backdrop so the result is opaque.
fn surface_to_image(surface: gtk::cairo::Surface) -> Option<Image> {
    let image = gtk::cairo::ImageSurface::try_from(surface).ok()?;
    image.flush();
    let (width, height, stride) = (image.width(), image.height(), image.stride());
    if width <= 0 || height <= 0 {
        return None;
    }
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    image
        .with_data(|data| {
            for row in 0..height {
                let line = &data[(row * stride) as usize..];
                for px in line.chunks_exact(4).take(width as usize) {
                    let argb = u32::from_ne_bytes([px[0], px[1], px[2], px[3]]);
                    let alpha = argb >> 24;
                    let channel = |shift: u32, back: u8| {
                        // Premultiplied colour, plus the backdrop showing through.
                        let c = (argb >> shift) & 0xff;
                        (c + (u32::from(back) * (255 - alpha)) / 255).min(255) as u8
                    };
                    rgba.extend_from_slice(&[channel(16, BACKDROP[0]), channel(8, BACKDROP[1]), channel(0, BACKDROP[2]), 255]);
                }
            }
        })
        .ok()?;
    Some(Image { width: width as u32, height: height as u32, rgba })
}

/// What `window`'s page shows, rendered by WebKit, and how many image pixels
/// make one CSS pixel. Blocking: the snapshot is taken on the GTK thread.
fn snapshot(window: &tauri::WebviewWindow) -> Option<(Image, f64)> {
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            webview.inner().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::NONE,
                None::<&gtk::gio::Cancellable>,
                move |result| {
                    let _ = tx.send(result.ok().and_then(surface_to_image));
                },
            );
        })
        .ok()?;
    let image = rx.recv_timeout(Duration::from_secs(5)).ok().flatten()?;
    // The page's CSS pixels are the window's logical pixels; the image may be
    // drawn at the display's scale, so measure rather than assume.
    let logical_width = window.inner_size().ok()?.width as f64 / window.scale_factor().ok()?;
    let ratio = if logical_width > 0.0 { image.width as f64 / logical_width } else { 1.0 };
    Some((image, ratio))
}

fn to_clipboard(image: &Image) -> bool {
    let (width, height, rgba) = (image.width as i32, image.height as i32, image.rgba.clone());
    on_gtk_thread(move || {
        let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_bytes(
            &gtk::glib::Bytes::from_owned(rgba),
            gtk::gdk_pixbuf::Colorspace::Rgb,
            true,
            8,
            width,
            height,
            width * 4,
        );
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        clipboard.set_image(&pixbuf);
        // Hand it to the clipboard manager so it outlives the meter.
        clipboard.store();
        true
    })
    .unwrap_or(false)
}

fn to_file(image: &Image, path: &Path) -> bool {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, encode_png(image.width, image.height, &image.rgba)).is_ok()
}

/// Capture a CSS-pixel rect of `caller` (plus all of `meter`, if given, beside
/// it: Wayland does not say where windows are, so they cannot be placed as on
/// screen), put it on the clipboard and optionally write it to `png_path`.
/// Blocking. Returns (clipboard ok, file ok).
#[allow(clippy::too_many_arguments)]
pub fn capture(
    caller: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    _scale: f64,
    meter: Option<&tauri::WebviewWindow>,
    png_path: Option<&Path>,
) -> (bool, bool) {
    let Some((page, ratio)) = snapshot(caller) else {
        tracing::warn!("Screenshot: WebKit gave no snapshot");
        return (false, false);
    };
    let px = |v: f64| (v * ratio).round().max(0.0) as u32;
    let mut image = page.crop(px(x), px(y), px(width), px(height));
    if let Some((meter_page, _)) = meter.and_then(snapshot) {
        image = Image::beside(&meter_page, &image);
    }
    let clipboard = to_clipboard(&image);
    let file = png_path.is_some_and(|path| to_file(&image, path));
    (clipboard, file)
}

/// `~/Pictures/A2Tools DPS Meter` (or the XDG Pictures folder wherever it is).
pub fn default_folder() -> Option<PathBuf> {
    let pictures = gtk::glib::user_special_dir(gtk::glib::UserDirectory::Pictures)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Pictures")))?;
    Some(pictures.join(crate::fork::APP_NAME))
}

/// The desktop's folder picker. Blocks until the player chooses or cancels.
pub fn pick_folder(_owner: &tauri::WebviewWindow, start_in: Option<&str>) -> Option<String> {
    let start_in = start_in.filter(|s| !s.is_empty()).map(PathBuf::from);
    on_gtk_thread(move || {
        let dialog = gtk::FileChooserNative::new(
            Some("Choose a folder for screenshots"),
            None::<&gtk::Window>,
            gtk::FileChooserAction::SelectFolder,
            None,
            None,
        );
        if let Some(start) = start_in {
            let _ = dialog.set_current_folder(start);
        }
        let chosen = (dialog.run() == gtk::ResponseType::Accept)
            .then(|| dialog.filename())
            .flatten();
        chosen.map(|path| path.display().to_string())
    })
    .flatten()
}

/// The top-right corner of the game's picture, through KWin (KDE Plasma
/// only), where the KWin script said the game is.
///
/// KWin is asked by a helper process, never by the app: KWin lets a program
/// read the screen by its executable (/proc/<pid>/exe), which Linux hides
/// from other programs while the app holds cap_net_raw for capture, so KWin
/// refused every call. The helper, `daeva-companion-hotkeys --minimap`, has
/// no capabilities (see `hotkeys`): asked `x y width height` on its stdin,
/// it answers `ok <width> <height>` and the RGBA rows, or `error <why>`.
pub fn game_corner() -> Result<crate::platform::screenshot::GameCorner, String> {
    use std::io::{BufRead, Read, Write};

    if !super::process::is_kde() {
        return Err("Reading the minimap works on KDE Plasma (and Windows)".into());
    }
    let (x, y, w, h) = super::focus::game_area().ok_or("AION2's window isn't known yet: is it open?")?;
    let rect = crate::platform::screenshot::corner_of((x, y, w, h));
    let mut slot = HELPER.lock().unwrap_or_else(|p| p.into_inner());
    if slot.is_none() {
        *slot = Some(start_helper()?);
    }
    let answer = (|| -> Result<(u32, u32, Vec<u8>), String> {
        let helper = slot.as_mut().ok_or("no helper")?;
        writeln!(helper.stdin, "{} {} {} {}", rect.left, rect.top, rect.width, rect.height).map_err(|e| e.to_string())?;
        helper.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        if helper.stdout.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("the minimap reader stopped".into());
        }
        let mut words = line.trim_end().splitn(3, ' ');
        match (words.next(), words.next(), words.next()) {
            (Some("ok"), Some(width), Some(height)) => {
                let (width, height): (u32, u32) = (width.parse().map_err(|_| "bad answer")?, height.parse().map_err(|_| "bad answer")?);
                let mut rgba = vec![0u8; width as usize * height as usize * 4];
                helper.stdout.read_exact(&mut rgba).map_err(|e| e.to_string())?;
                Ok((width, height, rgba))
            }
            _ => Err(format!("Minimap: {}", line.trim_end().strip_prefix("error ").unwrap_or(line.trim_end()))),
        }
    })();
    match answer {
        Ok((width, height, rgba)) => Ok(crate::platform::screenshot::GameCorner { game_width: w, game_height: h, width, height, rgba }),
        Err(e) => {
            // Gone or out of step: a new one next time.
            if slot.as_mut().is_some_and(|helper| helper.child.try_wait().ok().flatten().is_some()) || e.starts_with("the minimap") {
                *slot = None;
            }
            Err(e.strip_prefix("Minimap: ").map(str::to_string).unwrap_or(e))
        }
    }
}

struct Helper {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: std::io::BufReader<std::process::ChildStdout>,
}

static HELPER: std::sync::Mutex<Option<Helper>> = std::sync::Mutex::new(None);

fn start_helper() -> Result<Helper, String> {
    use std::process::{Command, Stdio};
    let path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(super::hotkeys::HELPER)))
        .filter(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from(super::hotkeys::HELPER));
    let mut child = Command::new(&path)
        .arg("--minimap")
        // Its stdin is how it learns the app is gone: it exits at EOF.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", path.display()))?;
    let stdin = child.stdin.take().ok_or("no helper stdin")?;
    let stdout = std::io::BufReader::new(child.stdout.take().ok_or("no helper stdout")?);
    Ok(Helper { child, stdin, stdout })
}

/// The helper's whole life: read areas from stdin, answer each with its
/// pixels, until stdin closes.
pub fn run_minimap_helper() -> i32 {
    use std::io::{BufRead, Write};
    allow_screenshots();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let n: Vec<i64> = line.split_whitespace().filter_map(|v| v.parse().ok()).collect();
        let answer = match n[..] {
            [x, y, w, h] if w > 0 && h > 0 && w <= 4096 && h <= 4096 => capture_area(x as i32, y as i32, w as u32, h as u32),
            _ => Err("bad request".to_string()),
        };
        let written = match answer {
            Ok((w, h, rgba)) => writeln!(out, "ok {w} {h}").and_then(|_| out.write_all(&rgba)),
            Err(e) => writeln!(out, "error {}", e.replace('\n', " ")),
        };
        if written.and_then(|_| out.flush()).is_err() {
            break;
        }
    }
    0
}

/// An area of the screen as RGBA rows, from KWin's ScreenShot2.
fn capture_area(x: i32, y: i32, width: u32, height: u32) -> Result<(u32, u32, Vec<u8>), String> {
    use std::collections::HashMap;
    use std::io::Read;
    use zbus::zvariant::{Fd, OwnedValue, Value};

    let connection = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let proxy = zbus::blocking::Proxy::new(&connection, "org.kde.KWin", "/org/kde/KWin/ScreenShot2", "org.kde.KWin.ScreenShot2")
        .map_err(|e| e.to_string())?;
    let (mut reader, writer) = std::io::pipe().map_err(|e| e.to_string())?;
    // KWin writes the pixels after it answers: read them as they come.
    let read = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).map(|_| bytes)
    });
    let options: HashMap<&str, Value> = HashMap::from([("include-cursor", Value::from(false)), ("native-resolution", Value::from(false))]);
    let answer: Result<HashMap<String, OwnedValue>, _> = proxy.call("CaptureArea", &(x, y, width, height, options, Fd::from(&writer)));
    drop(writer);
    let bytes = read.join().map_err(|_| "reading the screen failed")?.map_err(|e| e.to_string())?;
    let answer = answer.map_err(|e| {
        let e = e.to_string();
        // KWin finds a new entry a few seconds after it is written.
        if e.contains("NoAuthorized") { "Waiting for KDE to allow reading the minimap…".to_string() } else { e }
    })?;
    let n = |key: &str| answer.get(key).and_then(|v| u32::try_from(v).ok()).unwrap_or(0);
    let (width, height, stride, format) = (n("width"), n("height"), n("stride") as usize, n("format"));
    if width == 0 || height == 0 || bytes.len() < stride * height as usize {
        return Err("KWin gave no picture".into());
    }
    // QImage formats: 4-6 are 32-bit BGRA in memory, 16-18 RGBA.
    let bgra = match format {
        4..=6 => true,
        16..=18 => false,
        other => return Err(format!("KWin's picture is in a format not read here ({other})")),
    };
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for row in bytes.chunks(stride).take(height as usize) {
        for px in row[..width as usize * 4].chunks_exact(4) {
            let (r, b) = if bgra { (px[2], px[0]) } else { (px[0], px[2]) };
            rgba.extend_from_slice(&[r, px[1], b, 255]);
        }
    }
    Ok((width, height, rgba))
}

/// KWin lets a program use ScreenShot2 when a desktop entry whose Exec is that
/// program says so. This one says it for the running helper, wherever it is
/// run from, and is kept out of menus. KDE's service cache is rebuilt when it
/// is new or changed, so KWin finds it.
fn allow_screenshots() {
    static DONE: std::sync::Once = std::sync::Once::new();
    DONE.call_once(|| {
        let Some(exe) = std::env::current_exe().ok().and_then(|p| p.canonicalize().ok()) else { return };
        let Some(dir) = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        else {
            return;
        };
        let path = dir.join("applications").join(format!("{}-minimap.desktop", crate::fork::APP_ID));
        let entry = format!(
            "[Desktop Entry]\nType=Application\nName={} (minimap reader)\nExec={}\nNoDisplay=true\nX-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2\n",
            crate::fork::APP_NAME,
            exe.display()
        );
        if std::fs::read_to_string(&path).ok().as_deref() == Some(entry.as_str()) {
            return;
        }
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&dir));
        if std::fs::write(&path, entry).is_err() {
            tracing::warn!("Minimap: could not write {}", path.display());
            return;
        }
        tracing::info!("Minimap: KWin may read the screen for {} ({})", exe.display(), path.display());
        for tool in ["kbuildsycoca6", "kbuildsycoca5"] {
            if std::process::Command::new(tool).arg("--noincremental").output().is_ok() {
                break;
            }
        }
    });
}
