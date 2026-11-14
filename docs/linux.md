# Ezzar's Daeva Companion on Linux (Proton)

The app runs natively on Linux while AION 2 runs under Proton. Install the package for your system below: it sets up everything, packet-capture permission included. Only on a distribution with no package do you need to build it yourself.

Every package needs a 64-bit (x86_64) system with WebKitGTK 4.1: Ubuntu 22.04, Debian 12, Fedora 39 or newer, any current Arch, or Bazzite.

- **[Install](#install)**
- **[Update](#update)**
- **[Start and remove](#start-and-remove)**
- **[Global hotkeys](#global-hotkeys)**
- **[GNOME: keep the meter above other windows](#gnome-keep-the-meter-above-other-windows)**
- **[Build from source](#build-from-source-other-distributions)**
- **[Logs for a bug report](#logs-for-a-bug-report)**
- **[Tiling desktops](#tiling-desktops-hyprland-sway-i3)** (Hyprland, Sway, i3)
- **[Troubleshooting](#troubleshooting)**

## Install

Download the package for your system from the [releases page](https://github.com/Ezzaro14/ezzar-daeva-companion/releases), then install it from the folder you saved it to. Each package grants the packet-capture permission itself, so you never need `setcap`.

| System | Package | Install |
| --- | --- | --- |
| CachyOS, Arch, Manjaro, EndeavourOS | `daeva-companion-<version>-1-x86_64.pkg.tar.zst` | `sudo pacman -U ./daeva-companion-*-x86_64.pkg.tar.zst` |
| Ubuntu, Debian, Linux Mint, Pop!_OS | `Ezzar.s.Daeva.Companion_<version>_amd64.deb` | `sudo apt install ./Ezzar.s.Daeva.Companion_*_amd64.deb` |
| Fedora | `daeva-companion-<version>-1.x86_64.rpm` | `sudo dnf install ./daeva-companion-*.x86_64.rpm` |
| Bazzite, Silverblue, Kinoite, Aurora, Bluefin | the same `.rpm` | `rpm-ostree install ./daeva-companion-*.x86_64.rpm`, then restart |

The image-based Fedoras (Bazzite and the others in that row) keep the system read-only and add packages by layering them, which takes effect after a restart. The `.rpm` carries its packet-capture permission in the package itself, which those systems need.

To build a package yourself from a checkout instead: `cd packaging/arch/daeva-companion && makepkg -si` on Arch and its derivatives, or `packaging/linux/build-rpm.sh` in a Fedora toolbox (the package lands in `out/`).

## Update

Download the new version's package from the [releases page](https://github.com/Ezzaro14/ezzar-daeva-companion/releases) and install it the same way. Installing over the old version keeps your settings, fight history and module data.

To see which version you have, look at the bottom of the Settings sidebar, or ask the package manager:

| System | Command |
| --- | --- |
| Arch and its derivatives | `pacman -Q daeva-companion` |
| Ubuntu, Debian, Mint, Pop!_OS | `dpkg -s ezzar-s-daeva-companion \| grep Version` |
| Fedora, Bazzite | `rpm -q daeva-companion` |

## Start and remove

The app is in your application menu as **Ezzar's Daeva Companion**. To start it from a terminal with its output saved, which helps with a bug report:

```bash
daeva-companion 2>&1 | tee ~/daeva-console.log
```

To remove it:

| Installed on | Command |
| --- | --- |
| Arch and its derivatives | `sudo pacman -R daeva-companion` |
| Ubuntu, Debian, Mint, Pop!_OS | `sudo apt remove ezzar-s-daeva-companion` |
| Fedora | `sudo dnf remove daeva-companion` |
| Bazzite and other image-based Fedoras | `rpm-ostree uninstall daeva-companion`, then restart |

Your settings and data stay in `~/.local/share/app.ezzar.daeva-companion/`; delete that folder too to remove everything.

## Global hotkeys

The app's hotkeys (reset, show or hide, click-through lock and the others under **Settings → Keybinds**) work on Linux through your desktop's global shortcuts. They are off until you turn on **Use keybinds** there; turning it on registers them at once, and turning it off releases them. Wayland lets no app grab keys itself, so the app asks the desktop for them, and the desktop has the final say on which keys they use. The app suggests the keys set on the same tab.

The keys are registered by a small helper, `daeva-companion-hotkeys`, installed next to the app. The app itself holds the permission to capture packets (`cap_net_raw`), and Linux will not let the desktop's shortcut service read a program holding a permission the service does not have, so the app cannot register shortcuts itself. The helper has no such permission and only handles keybinds.

| Desktop | What happens |
| --- | --- |
| KDE Plasma 6 | On the first start, Plasma asks you to confirm the shortcuts. Change them later in **System Settings → Keyboard → Shortcuts** |
| GNOME 48 and later | GNOME asks you to confirm the shortcuts on the first start; change them in **Settings → Keyboard → Keyboard Shortcuts** |
| Hyprland | The app binds its keys itself each time it starts, unless a key is already bound in your config. To bind them yourself instead, see below |
| Other desktops | Works if the desktop's portal supports global shortcuts; otherwise there are no hotkeys |

**Hyprland.** The shortcuts are `app.ezzar.daeva-companion:reset`, `:toggle` and `:lock` (and the others in Settings → Keybinds). `hyprctl globalshortcuts` lists them while the app runs. To bind them in your config:

```lua
hl.bind("CTRL + ALT + R", hl.dsp.global("app.ezzar.daeva-companion:reset"))
hl.bind("CTRL + ALT + Up", hl.dsp.global("app.ezzar.daeva-companion:toggle"))
hl.bind("CTRL + ALT + L", hl.dsp.global("app.ezzar.daeva-companion:lock"))
```

On an older Hyprland that uses `hyprland.conf`:

```
bind = CTRL ALT, R, global, app.ezzar.daeva-companion:reset
bind = CTRL ALT, Up, global, app.ezzar.daeva-companion:toggle
bind = CTRL ALT, L, global, app.ezzar.daeva-companion:lock
```

A key the app finds already bound is left to your binding, so give its shortcuts keys of their own.

## GNOME: keep the meter above other windows

In a GNOME Wayland session, the app prefers XWayland when an X11 display is available, so its always-on-top request works without a GNOME Shell extension. Only the app uses XWayland; the desktop session stays on Wayland. An explicit `GDK_BACKEND` takes precedence:

```sh
GDK_BACKEND=x11 daeva-companion       # XWayland
GDK_BACKEND=wayland daeva-companion   # native Wayland, sharper at 125% or 150% scaling
```

GTK's native Wayland keep-above request has no effect in GNOME: there, focus the window, press **Alt+Space**, and select **Always on Top**.

On KDE Plasma the app adds KWin window rules for itself the first time it starts (listed in **System Settings → Window Management → Window Rules**), so the overlay stays above a fullscreen game and clicking it keeps the game focused.

## Build from source (other distributions)

### 1. Install the build tools

**Rust** (any distribution), then open a new terminal:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Node.js 18 or newer:** from your package manager, or from [nodejs.org](https://nodejs.org).

**System libraries**, for your distribution.

Debian, Ubuntu, Mint, Pop!_OS:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libpcap-dev git
```

Fedora:

```bash
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libpcap libcap git
sudo dnf group install c-development
```

Arch and its derivatives:

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg libpcap git
```

### 2. Download and build

The first build takes 10–15 minutes; later ones are much faster.

```bash
git clone https://github.com/Ezzaro14/ezzar-daeva-companion.git
cd ezzar-daeva-companion

# A fresh download lacks some data files the app reads; copy them into place
mkdir -p public/i18n public/data public/src/data
cp -r src/data/i18n/* public/i18n/
cp src/data/skill_icons.json src/data/dot_skill_ids.json public/data/
cp src/data/skill_icons.json src/data/dot_skill_ids.json public/src/data/

npm install
npx tauri build --no-bundle
cargo build --release --manifest-path src-tauri/Cargo.toml --bin daeva-companion-hotkeys
```

The app is then `src-tauri/target/release/daeva-companion`, with its hotkeys helper beside it.

### 3. Allow it to capture packets

Reading the game's network traffic needs a capability Linux only gives on request:

```bash
sudo setcap cap_net_raw=ep src-tauri/target/release/daeva-companion
```

- Redo this after every rebuild: a new build is a new file and loses the permission.
- Do not run the app with `sudo`. It would run as root, keep its settings in root's home folder, and often fail to open its window.
- `setcap` does not work on some drives (for example NTFS or exFAT shared with Windows). If it fails, build on a Linux-formatted drive.

## Logs for a bug report

1. Start AION 2 as you normally do, and the app from a terminal ([Start and remove](#start-and-remove)).
2. In **Settings → Advanced → Diagnostics**, turn on **Debug logging** and **Packet logging**.
3. Log in with a character, then fight a training dummy or some monsters for a minute or two.
4. Turn **Packet logging** off again, then close the app.

The files are `debug.log` and the newest `packets_YYYYMMDD_HHMMSS.txt` in `~/.local/share/app.ezzar.daeva-companion/`, and the console output in your home folder. They contain character names, yours and those of players near you, so share them only with someone you trust to look at them.

## Tiling desktops (Hyprland, Sway, i3)

A tiling window manager tiles every new window unless told otherwise, which breaks an overlay. Give the app's windows (class `daeva-companion`) a rule that makes them float, keeps them on every workspace, and turns off blur and borders. On Hyprland:

```lua
hl.window_rule({
    name = "daeva-companion",
    match = {
        class = "^(daeva\\-companion)$",
    },
    float = true,
    pin = true,
    no_blur = true,
    border_size = 0,
})
```

With `hyprland.conf`, set the same four things for that window class in its window-rule syntax. On Sway and i3, the equivalent is `floating enable` and `sticky enable` for `app_id`/`class` `daeva-companion`.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Build fails mentioning `webkit2gtk-4.1`, `pkg-config` or a missing library | Re-run the install line for your distribution. Distributions older than Ubuntu 22.04 lack `webkit2gtk-4.1`. |
| `debug.log` says it failed to load libpcap | Install libpcap (`libpcap0.8` on Debian and Ubuntu, `libpcap` elsewhere), then start the app again. |
| The app warns it is not running as admin, or `debug.log` has no `Capture active` lines | The capture permission is missing. Package: reinstall it. Build from source: run the `setcap` line again (a rebuild loses it). |
| `debug.log` says `No AION2 window found` while the game is running | The app did not find the game process; check `ps aux \| grep -i aion`. |
| `debug.log` says `Not locked yet` with `0 with game markers` while you fight | Capture sees traffic but not the game's: a VPN or ping reducer can cause this. |
| The window never opens (`Error 71 (Protocol error) dispatching to Wayland display`), or it is blank or white | Some setups (NVIDIA drivers especially) reject WebKit's GPU buffers; the app hands frames over in shared memory instead (`WEBKIT_DMABUF_RENDERER_FORCE_SHM=1`). Remove `WEBKIT_DISABLE_DMABUF_RENDERER=1` if you added it to a launcher. If it is still wrong, try `GDK_BACKEND=x11 daeva-companion`. |
| The meter goes behind the game | Run the game borderless or windowed. On Wayland an app cannot force itself above a fullscreen game. On GNOME, see [above](#gnome-keep-the-meter-above-other-windows); on KDE, restart the app once so it adds its window rules. |
| On a tiling desktop the meter is tiled beside the game | See [Tiling desktops](#tiling-desktops-hyprland-sway-i3). |
