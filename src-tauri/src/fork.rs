//! This fork's name and identity, kept in one place: Ezzar's Daeva Companion,
//! a fork of the A2Tools DPS Meter (GPL-3.0) with the features of Questlog's
//! desktop app added as bundled plugins (`plugins::bundled`).
//!
//! The names the desktop matches windows by (the window class, which is the
//! binary's name, and the overlay's title) must match `tauri.conf.json` and
//! Cargo.toml's binary.

/// What the player sees.
pub const APP_NAME: &str = "Ezzar's Daeva Companion";
/// The main binary, and the window class its windows carry on Linux.
pub const BINARY: &str = "daeva-companion";
/// The application id (`tauri.conf.json`'s identifier).
pub const APP_ID: &str = "app.ezzar.daeva-companion";
/// How uploads to a2tools.app name this meter (docs/third-party-meters.md):
/// a fork is not the A2Tools meter, and says so.
pub const CLIENT: &str = "daeva-companion";
/// Whether Send Logs to Dev goes to the A2Tools developers: not from a fork.
pub const SENDS_DEV_LOGS: bool = false;
