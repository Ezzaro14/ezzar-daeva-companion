//! Screenshots of the meter's own windows: to the clipboard, and optionally to
//! a PNG file.
//!
//! The page measures what to capture with `getBoundingClientRect`, which is in
//! CSS pixels relative to the window's client area. The screen is in physical
//! pixels, so the rect is scaled by the page's `devicePixelRatio` (Windows
//! display scaling, times any page zoom) and offset by where the client area
//! sits on screen. Skipping either crops or shifts the image at 125%/150%
//! scaling, which is what players reported.

/// A rectangle on screen, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenRect {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

impl ScreenRect {
    /// The smallest rectangle covering both.
    pub fn union(self, other: ScreenRect) -> ScreenRect {
        let left = self.left.min(other.left);
        let top = self.top.min(other.top);
        let right = (self.left + self.width).max(other.left + other.width);
        let bottom = (self.top + self.height).max(other.top + other.height);
        ScreenRect { left, top, width: right - left, height: bottom - top }
    }
}

/// A CSS-pixel rect inside a window's client area, as screen pixels, given the
/// client area's on-screen origin.
pub fn css_rect_to_screen(origin: (i32, i32), x: f64, y: f64, w: f64, h: f64, scale: f64) -> ScreenRect {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let left = origin.0 + (x * scale).round() as i32;
    let top = origin.1 + (y * scale).round() as i32;
    let right = origin.0 + ((x + w) * scale).round() as i32;
    let bottom = origin.1 + ((y + h) * scale).round() as i32;
    ScreenRect { left, top, width: (right - left).max(1), height: (bottom - top).max(1) }
}

/// Encode top-down RGBA rows as a PNG. Hand-rolled because the only thing
/// needed is "write these pixels", and flate2 is already a dependency.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    use std::io::Write;

    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let crc = crc32(&out[start..]);
        out.extend_from_slice(&crc.to_be_bytes());
    }

    let stride = width as usize * 4;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for row in rgba.chunks_exact(stride).take(height as usize) {
        raw.push(0); // filter: none
        raw.extend_from_slice(row);
    }
    let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = z.write_all(&raw);
    let idat = z.finish().unwrap_or_default();

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, deflate, no filter set, no interlace

    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &idat);
    chunk(&mut out, b"IEND", &[]);
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// The top-right corner of the game's picture, where its minimap is, for the
/// World Map to find you by (`plugins::bundled::plugin_map_minimap`).
pub struct GameCorner {
    /// The game's picture, without its window's frame.
    pub game_width: i32,
    pub game_height: i32,
    /// Top-down RGBA rows.
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// How much of the corner is taken, as parts of the game's height: its UI
/// scales with the height, and the minimap sits within 0.24 of it from the
/// right and 0.22 from the top (two screenshots, 1080 and 1007 tall,
/// 2026-10-21).
const CORNER_WIDTH: f64 = 0.30;
const CORNER_HEIGHT: f64 = 0.27;

/// The corner taken of a game picture at (x, y, width, height).
pub fn corner_of(game: (i32, i32, i32, i32)) -> ScreenRect {
    let (x, y, w, h) = game;
    let width = ((h as f64 * CORNER_WIDTH).round() as i32).min(w).max(1);
    let height = ((h as f64 * CORNER_HEIGHT).round() as i32).min(h).max(1);
    ScreenRect { left: x + w - width, top: y, width, height }
}

/// Capture, the default folder and the folder picker are the OS's, and so
/// is reading the game's corner.
pub use super::os::screen::{capture, default_folder, game_corner, pick_folder, run_minimap_helper};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_corner_is_the_top_right_of_the_game_by_its_height() {
        assert_eq!(corner_of((0, 0, 1920, 1080)), ScreenRect { left: 1596, top: 0, width: 324, height: 292 });
        // A window: its picture's own place.
        assert_eq!(corner_of((100, 28, 1911, 1007)), ScreenRect { left: 1709, top: 28, width: 302, height: 272 });
    }

    #[test]
    fn scales_css_pixels_to_the_screen() {
        // A 300x200 CSS-pixel panel at (10, 20) in a window whose client area
        // starts at (1000, 500), on a 150% display.
        let r = css_rect_to_screen((1000, 500), 10.0, 20.0, 300.0, 200.0, 1.5);
        assert_eq!(r, ScreenRect { left: 1015, top: 530, width: 450, height: 300 });
        // At 100% it is a plain offset.
        let r = css_rect_to_screen((1000, 500), 10.0, 20.0, 300.0, 200.0, 1.0);
        assert_eq!(r, ScreenRect { left: 1010, top: 520, width: 300, height: 200 });
    }

    #[test]
    fn union_covers_both_windows() {
        let meter = ScreenRect { left: 100, top: 100, width: 400, height: 300 };
        let details = ScreenRect { left: 520, top: 80, width: 800, height: 600 };
        assert_eq!(meter.union(details), ScreenRect { left: 100, top: 80, width: 1220, height: 600 });
    }

    #[test]
    fn png_is_well_formed() {
        let png = encode_png(2, 1, &[255, 0, 0, 255, 0, 0, 255, 255]);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
        // CRC of an empty IEND chunk is a fixed, well-known value.
        assert_eq!(&png[png.len() - 4..], &[0xAE, 0x42, 0x60, 0x82]);
    }
}
