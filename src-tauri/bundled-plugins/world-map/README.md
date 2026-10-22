# World Map

Your own screenshot of each world map, lined up with the game's coordinates, with what is known on it:

- **Kibelisks** (teleports) and **pet soul monster** areas, from Pet Soul Tracker's data (A2Tools-Plugins, GPL-3.0; `tools/build_world_map.py`).
- **Field bosses**, with their timers as players' meters share them (a2tools.app); a boss's spot is learnt the first time you see it.
- **Monsters you have seen** in your fights, remembered per map.
- **You and your party**, where you last cast a buff or skill.
- **Your pins**, and **imported** marker files (JSON or CSV, in game coordinates).
- **A map file you saved from gaming.tools** (`<map>.d.json`, saved from your browser's network tab): Hidden Cubes, gathering, Empyrean Traces, every monster spawn and the map's places, in layers you turn on yourself (`pack.js`). It is kept in this plugin's storage on your computer; none of it ships with the app.

## Adding a map image

Verteron and Altgard come with a picture, already lined up (`local/maps/`, made by `tools/world_map_pictures.cjs` from map tile packs saved from gaming.tools, with each picture's fit in `pictures.js`; personal, like `local/packs.js`). Line it up again as below to fine-tune it; **Start over** goes back to the fit it came with.

The game's map images can't be shipped publicly, so every other map uses your own screenshot: open the world map in game for the region, zoomed out to show all of it, take a screenshot, and choose it under **Map image**. One you choose replaces the picture a map came with. Then **Line it up**: pick three or more places (Kibelisks, or *where I am now*), clicking each where it is on the screenshot. The map is fitted to them, whatever the screenshot's size or crop.

Without an image the markers show on a grid, north up.

Comes with the meter; needs the `maps`, `feed:combat` and `feed:boss-timers` permissions (plugins/bundled.rs).
