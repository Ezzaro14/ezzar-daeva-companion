# What leaves your computer

Nothing about your fights, your character or your party is uploaded anywhere: the app has no account, no upload and no telemetry. This page lists what it does connect to, and what it keeps on your computer, with the source files that do it, so each claim can be checked.

## What the app connects to

**Shared field boss timers and the Abyss siege** (Event Timers, the World Map). Other players' meters report field boss kills and the Artifact Siege to a2tools.app, which publishes them per server. This app only reads that public feed:

- `https://cdn.a2tools.app/feeds/boss-timers/<server>.json` and `.../feeds/abyss-artifacts/<server>.json`, for your server (`src-tauri/src/plugins/mod.rs`, `feed_file`);
- while a module follows bosses, a WebSocket to `wss://a2tools.app/api/boss-timers/live?server=<server>` that names the bosses it follows (`src-tauri/src/plugins/boss_live.rs`).

The request names your server and those bosses, and nothing else; nothing your meter sees is sent back.

**The official AION 2 site** (Progression Guide). Character profiles are read from `api-search.plaync.com` and `aion2.plaync.com`: yours, the players you add, and players of your class you met in your fights (`src-tauri/src/plugins/armory.rs`). Each is kept for a day in `armory/` so it is read once.

**aion2pets.net's pet list** (Pet Soul Tracker), at most once a day, kept in `pet-catalog.json`: pets newer than the tracker's own data show up from it (`src-tauri/src/plugins/pet_catalog.rs`). The request is a plain page read; it carries nothing about you.

**Skill and buff icons**, from the game's own CDN, `assets.playnccdn.com`. The windows' content security policy allows no other site (`src-tauri/tauri.conf.json`).

**npcap.com**, on Windows, when the app offers to install Npcap and you accept (`src-tauri/src/npcap_setup.rs`).

**The stream overlay**, only if you turn it on under *Settings → Streaming*: a small web server on your local network, so OBS on another PC can show the meter. Every request needs the key from Settings (`src-tauri/src/stream_overlay/`).

Links you click (a map link, the release notes) open in your browser.

## What it keeps on your computer

Everything is under `%APPDATA%\app.ezzar.daeva-companion\` on Windows and `~/.local/share/app.ezzar.daeva-companion/` on Linux.

### Fight history: `history/*.json`

One file per boss fight, saved automatically: damage, skills, timings and per-player summaries. Party members' names are masked when the record is made, not when it is shown (`obscure_nickname` in `src-tauri/src/entity/fight_record.rs` keeps the first and last character), so a saved file holds `Ta****x`, not the name. Your own name is kept.

### Recent traffic, in memory only

The app keeps the game traffic it has just parsed in memory for about an hour (`src-tauri/src/share/ring.rs`), the same data it reads to draw the meter, so a boss fight's packets are there when the fight is saved. It is never written to disk as such and is gone when the app closes.

### Evidence slices: `slices/`

When a boss fight is saved, its packets are cut from that memory into an Evidence Slice beside the history: `<fight>.a2es.gz`, typically tens of kilobytes, and a small `<fight>.json` noting which actor was you. A slice holds only the packet types the damage parser reads, with every character name replaced by an opaque token. It lets a fight be replayed through the parser to track down a bug. Deleting a fight deletes its slice, and slices of fights gone from the history are removed.

### Module data: `plugin-data/`, `maps/`, `armory/`

What each module saves: pet levels, timers you track, your planner, map pictures and markers you added, the character profiles above.

### Packet capture: `packets_*.txt`

**Off by default.** Written only while *Settings → Advanced → Packet logging* is on. It is a debugging tool, and it records **the whole server-to-client game connection**, not just combat: AION 2 sends everything down one connection. Running

```
A2_REPLAY_CAPTURE=<your capture> cargo test --test capture_contents -- --ignored --nocapture
```

over one ordinary dungeon run found player chat (including public channels), names of players who were not in the party, account statistics, session ids and server addresses. Read that output before sharing a capture with anybody. The files grow for as long as the setting is on; delete them when you are done.

### The developer capture tool

`src-tauri/diagnostics/packet_dump.rs` is a developer tool, not part of the released app. It captures on every network adapter with no filter, so it records other applications' traffic too. Its `rawpackets_*.txt` files are far more sensitive than the ones above.
