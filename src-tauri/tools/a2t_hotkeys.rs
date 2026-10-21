//! `a2tools-hotkeys`: the meter's global hotkeys on Linux, in a process of
//! their own (see `platform::linux::hotkeys`), and with `--minimap` the World
//! Map's reads of the game's minimap (`platform::linux::screen`): both need a
//! process without the meter's capture capability. The meter starts it; it
//! is not meant to be run by hand.

fn main() {
    use a2tools_dps_meter_lib::platform;
    if std::env::args().nth(1).as_deref() == Some("--minimap") {
        std::process::exit(platform::screenshot::run_minimap_helper());
    }
    std::process::exit(platform::hotkeys::run_helper());
}
