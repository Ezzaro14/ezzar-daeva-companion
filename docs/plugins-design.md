# Plugins

Every module of the app (Event Timers, Pet Soul Tracker, the World Map and the rest) is a plugin: a folder of HTML and JavaScript that the app runs beside the meter, kept out of its core. The ones the app ships are in `src-tauri/bundled-plugins/`; in developer mode (Settings → Plugins) more can be loaded from folders on your computer, for building and testing them. A folder with the id of a built-in module runs in that module's place.

## What a plugin is

A folder:

```
pet-souls/
  manifest.json      id, name, version, apiVersion, permissions, decoders, ui
  index.html         the plugin's page
  plugin.js          its code
  style.css
  README.md
```

`manifest.json`:

```json
{
  "id": "pet-souls",
  "name": "Pet Soul Tracker",
  "version": "0.5.3-daeva.1",
  "apiVersion": 2,
  "description": "Souls still needed to raise each pet to level 3.",
  "permissions": ["storage", "events:character", "decoder:pet-list"],
  "decoders": [ … see below … ],
  "ui": { "panel": { "width": 320, "height": 420 } }
}
```

## Runtime: the sandbox

The dashboard runs every plugin that is on, each as a page in a sandboxed frame of its own (`public/src/js/dashboard.js`):

- The frame has `sandbox="allow-scripts"` and no `allow-same-origin`: an opaque origin, with no access to the dashboard, its storage or `window.__TAURI__`.
- Its files are served from the `a2plugin` scheme with a content security policy of their own: no network and no remote scripts.
- It talks to the app only by `postMessage` to the dashboard, which checks every request against the manifest's permissions and names the plugin to the backend, which checks again (`src-tauri/src/plugins/mod.rs`, `require`).

## The API

A plugin loads the `a2` object from `/_sdk/a2.js` (`src-tauri/src/plugins/a2.js`, which documents every call). What it may use depends on its permissions:

| Permission | Gives |
| --- | --- |
| `storage` | `a2.storage.get/set`: its own JSON values, up to 1 MB each, in `plugin-data/<id>/` |
| `events:character` | Your character (name, server, class, level) and when it changes |
| `decoder:<name>` | The fields its own decoder reads from the game (below) |
| `window`, `widgets` | Small windows of its own on the overlay, which you can place and lock |
| `notify`, `notify:system` | Messages on the overlay; desktop notifications while the game is closed |
| `feed:combat` | Your casts, the buffs and debuffs on you and your party, PvP, training totals (`src-tauri/src/combat/combat_feed.rs`) |
| `feed:boss-timers` | The field boss timers and Abyss siege other players share on a2tools.app's public feed |
| `feed:armory` | Character profiles from the official AION 2 site |
| `maps` | Map pictures and marker files you pick |

## Decoders: game data without raw packets

A plugin that needs game data describes the packets and fields it wants; the app runs the decoder and the plugin only ever receives the numbers (`src-tauri/src/plugins/decoder.rs`):

```json
"decoders": [{
  "name": "soul-gained",
  "opcode": "?? ??",
  "fields": [
    { "type": "skip:1" },
    { "name": "pet", "type": "u32" },
    { "name": "amount", "type": "u32" }
  ]
}]
```

- Fields are read in order: `u8`, `u16`, `u32`, `u64`, `i32`, `varint`, `skip:N`, and `list` of those (at most 32 fields, 4096 list entries, two levels deep).
- Numbers only: there are no string fields, so no names can be read.
- Events reach a plugin exactly once and in order, with the time they were read. A plugin with `events:character` gets them half a second later, stamped with the character: at login the game sends some data just before the record saying who is playing. A decoder with `"immediate": true` skips that wait.
