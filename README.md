# Ezzar's Daeva Companion

An AION 2 DPS meter with combat overlays for **Windows and Linux**: the functions of Questlog's desktop app (Windows only), built on the open-source [A2Tools DPS Meter](https://github.com/taengu/A2Tools-DPS-Meter).

It reads a copy of the game's network traffic (Npcap on Windows, libpcap on Linux). It never touches the game's files or memory. On Linux it runs natively while AION 2 runs under Proton.

## One dashboard, one overlay

Everything is in one **dashboard** window (it opens with the app; the meter's header has a button for it too): a sidebar with every module, and at the top one set of controls for everything on screen.

- **One overlay.** Every bar, alert, timer and popup is drawn in a single transparent window over the game, on the game's screen. On KDE it follows the game to whichever screen it is on (a KWin script places it, and keeps it and the meter off the taskbar); elsewhere the app places it. Pick a screen yourself under **Overlay → Screen**.
- **Edit layout** dims the screen, shows a sample of every alert with its name, and lets you drag anything into place; things snap to a grid and to the screen's middle. **Done** on the screen ends it, and **Reset layout** puts everything back where it started.
- **Lock** (on from the start, and **Ctrl+Alt+L** with global hotkeys on) lets every click through to the game; unlocked, only the widgets themselves take clicks, never the space around them. **Hide all** hides the meter and the overlay.
- **Timers:** what you track (world bosses, Abyss bosses, events) sits in one list on the overlay, folded to the next timer until you click it open, even while locked. Event Timers' **Settings** has the list's own part (show it, what it shows folded, such as everything up or starting within 30 minutes, and how many it lists open) and the popups' part. Nothing else shows: no icon per timer. You pick what to track on Event Timers' **Track** tab; each tracked one gets a popup a few minutes before it starts (its bell turns that off).
- **Setup guide:** on first start the dashboard walks through the app a step at a time (your screen and modules, what to track, cooldown bars, alerts, the map, your character, your routine, placing things). It's on Home to run again.
- Closing the dashboard only hides it: the modules keep running, and their overlays and alerts with them. **Notices** shows every module's alert as a popup over the game, such as a Spacetime Rift about to open or a world boss due.

## What it does

- **DPS meter:** party ranking, share, crit, per-skill details, targets (all, bosses, current)
- **Combat Assist:** skill cooldowns and buffs on bars anywhere, glow when ready, square/round/bars, row/stacked, hide out of combat
- **Fight history:** saved boss fights, damage, healing, taken, buffs, DPS over time
- **Combat logs website:** shareable reports, rankings, leaderboards via a2tools.app (uploads are labeled as this fork)
- **PvP Overlay**, opponents, damage dealt/taken, HP, class, defeated; saved sessions with kills, deaths, biggest burst, skills, DPS over time
- **Fight Records** Training mode: timed runs (30 s – 5 min or unlimited) on a dummy, your damage only, names, notes, groups, side-by-side comparison
- **Fight Records** Personal bests
- **Combat Alerts** loss-of-control notice (stun, sleep, fear, knockdown…) with time left. Party debuff alerts (same debuff on several members, e.g. Heal Block)
- **Dungeon Runs** clear time, deaths, each member's numbers, every boss fight
- **Event Timers** Event alerts (Shugo Festival, Rift, resets, sieges, and bosses), sound, desktop notifications while the game is closed 
- **Ping** overlay plugin
- **Pet Soul Tracker**, souls per pet, phases, drop sources
- **World Map**: your own screenshots, lined up with game coordinates; Kibelisks, pet soul monster areas, field bosses with timers, monsters you've seen, you and your party, pins, imported markers 
- **Progression Guide**: your character from the official site, compared with the strongest of your class, and a gear score roadmap 
- **Daily Planner**: Daily Duties, Shugo Festival's three keys, Nightmare, the week's dungeon entries, Odyle Energy, your own tasks; reminders before a reset 

Each module can be turned off on the dashboard's **Overlay** page.

### The World Map

Verteron and Altgard come with their map pictures, lined up from the start (this private build's own, stitched from gaming.tools' tile packs). The game's map art can't be shipped publicly, so every other map uses a picture you add: open the world map in game zoomed out to the whole region and take a screenshot (or use a map picture you have), then paste it (Ctrl+V), drop it on the map, or choose it. The markers are spread over it at once; **drag them** (and size, turn or mirror them) until the Kibelisks sit on the teleport statues, or **click three known places** (Kibelisks, or where you stand in game) for an exact fit. The picture stays on your computer.

The markers come from the openly licensed community data the A2Tools plugins ship (GPL-3.0: Kibelisks, pet soul monster areas, field bosses), what the game tells the app as you play (where you, your party and monsters are when they cast), your own pins, and marker files you import (JSON or CSV in game coordinates). The big fan maps (interactivemap.app, which aion2atlas.app's markers come from) don't allow their marker database to be copied or scraped, so hidden cubes, gathering nodes and the like aren't included.

### The Progression Guide

Reads your character (gear and enchants, Daevanion boards node by node, skills, pet and wings) from the official AION 2 site's public profile, and the strongest players of your class: the top of a2tools.app's leaderboard for your region, players you've met in your fights, and any you add. It ranks what to improve first: enchant gaps, unfinished boards and the nodes most of them take, skills most of them equip or level higher. It compares numbers; it doesn't know what each step costs. **Look up a character** shows the same for anyone.

The **Roadmap** tab shows your gear score against the milestones of [RaidRelay's gear score guide](https://raidrelay.com/aion-2-gear-score-guide) (1,000, 1,400, 1,600 … 2,800), what gets you to the next one, and checks on your own gear that need no comparison: empty accessory and rune slots, runes to +1 only, belt and amulet to +10 then Substance Morph, Stigma skills to level 20, better PvE titles.

### The Daily Planner

A checklist of each day's and week's runs, counted per character and reset at the game's resets (07:00 UTC, the weekly one on Wednesday; both can be changed): Duty Missions, Shugo Festival, Nightmare, Dimensional Invasion, Odyle Energy; Unknown Fissure's 14 entries, the Ascension Trial, Expedition reward counts, Substance Morph's Odyle crafts, Conquest and Transcendence counts, and the shops' weekly limits. More (raids, Subjugation, Battlefield, Command and Abyss Commands, Abyss time, the Daeva Pass) can be added under Edit tasks. A few hours before a reset it pops up what's left that would be lost. Every task can be changed, and your own added. From [metabot.gg](https://metabot.gg/en/aion-2/guides/daily-weekly-checklist)'s and [games.gg](https://games.gg/aion-2/guides/aion-2-daily-weekly-checklist/)'s checklists.

### How cooldowns are known

The game sends no record when a skill goes on cooldown, so Combat Assist learns each cooldown from use: the shortest time between two casts (a single much shorter one is taken as a cooldown another skill shortened, and marked ▼). A cooldown counts once the same gap is seen twice (a first guess shows as ~), and a skill whose hit lands after the cast (a delayed explosion) counts as one cast. Re-learn forgets a wrong one; or type the seconds yourself. A bar can also show its icons only while they're on cooldown.

## Install

### Bazzite, Silverblue, Kinoite (image-based Fedora)

Build the package (once, in a Fedora toolbox or distrobox with the [build dependencies](docs/linux.md#build-from-source-other-distributions) plus `rpm-build cpio`):

```bash
packaging/linux/build-rpm.sh
```

Then layer it and restart:

```bash
rpm-ostree install ./out/daeva-companion-*.x86_64.rpm
systemctl reboot
```

The package grants the packet-capture permission itself (no `setcap`). Start **Ezzar's Daeva Companion** from the app menu, then AION 2. On KDE Plasma the meter adds window rules to stay above the game, as upstream does ([Linux guide](docs/linux.md)).

### Fedora

```bash
packaging/linux/build-rpm.sh
sudo dnf install ./out/daeva-companion-*.x86_64.rpm
```

### Windows 10/11

1. Install [Npcap](https://npcap.com) with **WinPcap API-compatible Mode** checked.
2. Build the installer on Windows with [Rust](https://rustup.rs/) and [Node.js](https://nodejs.org/):

   ```powershell
   npm install
   npx tauri build
   ```

   The MSI is in `src-tauri/target/release/bundle/msi/`.
3. Run it as administrator (needed for packet capture).

## Developing

```bash
npm install
npx tauri dev
cd src-tauri && cargo test            # parser, combat feed and plugin host tests
```

- `src-tauri/src/combat/combat_feed.rs`: what the bundled overlays read (your casts and learned cooldowns, live buffs and debuffs on you and your party, PvP, training dummy totals, the dungeon you're in).
- `src-tauri/src/plugins/bundled.rs`: the bundled plugins, the dashboard and its overlay controls, the `feed:combat`, `notify:system` and `maps` permissions, fight events, notices, clipboard, map files.
- `src-tauri/src/plugins/armory.rs`: characters from the official site and the comparison pool (`feed:armory`).
- `public/dashboard.html`, `public/src/js/dashboard.js`: the dashboard, hosting each module's page.
- `tools/build_world_map.py`: the World Map's places, from the A2Tools plugins' data.
- `tools/world_map_pictures.cjs`: the World Map's own map pictures, from gaming.tools tile packs (`.gtpk`) saved from your browser.
- `src-tauri/bundled-plugins/`: the plugins themselves (HTML/JS, see `src-tauri/src/plugins/a2.js` for their API).
- `src-tauri/src/fork.rs`: this fork's name and identity in one place.

Upstream is kept as the `upstream` remote, and the fork's changes sit in new files where possible, so game-patch fixes merge in with `git pull upstream main`.

## Credits and license

GPL-3.0, like what it is built on:

- [A2Tools DPS Meter](https://github.com/taengu/A2Tools-DPS-Meter) by taengu and contributors: the meter, the protocol work and the plugin host. Its own README is [README.upstream.md](README.upstream.md).
- [A2Tools-Plugins](https://github.com/taengu/A2Tools-Plugins): Event Timers, Pet Soul Tracker and Ping, bundled here (Event Timers adds desktop notifications while the game is closed).

Not affiliated with NCSOFT, Questlog or A2Tools. Third-party meters may be against the game's terms of service; use at your own risk.
