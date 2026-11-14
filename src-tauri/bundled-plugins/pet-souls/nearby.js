// Pet Soul Tracker's "Around you": where you are, the map you're on and the
// monsters in range, without the page, so a test can load this file alone.
//
// What the game sends (worked out from captures of 2026-10-25, 855 spawns):
// - `41 36` an NPC coming into range, or respawning: entity, 3 bytes, its NPC
//   id (u32: the npcId sources.js lists), 2 bytes, its position.
// - `42 36` an NPC going: entity, then 00 01. As its corpse goes after a
//   kill, and as it leaves your range (345 of 386 spawns in one capture).
// - `21 36` a map loading: a number, the map id (sources.js's mapId), 8
//   bytes, where you arrive.
// - `41 36` also brings players' spirits and ground spells (292xxxx), left
//   out; `42 36` any entity going, players too.
// - `2a 38` a record about you as an effect of your own lands on you
//   (fighting, mounting, gliding: 6 in a minute of moving, 2026-10-25), and
//   `2b 38` your mantras ticking on you once a second (both as Hidden Cube
//   Finder reads them). Running alone sends nothing. The meter passes on only
//   your own ("self"), once it knows which entity is you: from the game's
//   record about you (at login and each map change, a few seconds after the
//   map loads), or a while after it started mid-session.
// - `23 36` a teleport: a 0, 5 bytes, where it put you.
// Only your own position is read, never another player's. While only walking, where you are is guessed from the monsters
// coming into view: they first appear 10 to 33 m from you as you move
// (median 24 m), mostly ahead. Their middle, moved back toward where you were
// last known, is within about 20 to 30 m (as Shugo.GG's map says of its own).
// Monsters' own moves (`1c 37`, a few a second) aren't followed: they stay by
// their spawn unless they are fighting you, and the meter keeps every event
// for a plugin's window (20,000), which they would fill.
// Positions are 32-bit floats in centimetres (passed as u32); north is -y,
// east +x.
(() => {
  // A teleport or map load leaves the monsters behind, except those that
  // came with it (their spawns can be read just before it).
  const MOVE_KEEP_MS = 3000;
  // A monster this far from you was missed going: out of range long ago.
  const FORGET_M = 200;
  // Your last exact position stands this long; after it, what has come into
  // view since says where you are.
  const EXACT_MS = 3000;
  // Arrivals this recent count, at least this many.
  const ARRIVALS_MS = 8000;
  const ARRIVALS_MIN = 2;
  // Arrivals come mostly ahead of you: their middle is moved back this far.
  const BACK_M = 15;
  // An arrival farther from where you were last known than this (60 m, and
  // 15 m for every second since: faster than flying) isn't one around you.
  // Scored on 33 gaps in captures of 2026-10-19 and -25, the estimate came
  // within 31 m three times in four (55 m without this rule).
  const REACH_M = 60;
  const REACH_M_PER_S = 15;

  // A player's spirit or ground spell: every NPC a player's skill spawns is
  // 2920011-2921399 (the meter's player_summon_npcs.json, from the game's
  // NpcData), and no soul comes from one. Left out of the map and of the
  // arrivals that place you (they appear by their player, not by you).
  const playerSummon = (npc) => npc >= 2_920_000 && npc < 2_930_000;
  const toFloat = (u) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, u >>> 0, true);
    return view.getFloat32(0, true);
  };
  // A position, or null when the numbers can't be one.
  const position = (d) => {
    const pos = [toFloat(d.x), toFloat(d.y), toFloat(d.z)];
    return pos.every((v) => Number.isFinite(v) && Math.abs(v) < 2e6) && pos.some((v) => v !== 0) ? pos : null;
  };
  // Distance on the map, ignoring height.
  const metres = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / 100;
  // Degrees clockwise from north.
  const bearing = (a, b) => (Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180 / Math.PI + 360) % 360;
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];

  class Field {
    constructor() {
      this.npcs = new Map(); // entity -> { entity, npc, pos, at }
      this.me = null; // { pos, at }
      this.mapId = null;
      this.arrivals = []; // { pos, at }: monsters coming into view
    }
    #arrived(pos, at) {
      this.arrivals = this.arrivals.filter((a) => at - a.at <= ARRIVALS_MS);
      this.arrivals.push({ pos, at });
    }
    spawn(d, at) {
      const pos = position(d);
      if (!pos || !(d.npc > 0) || playerSummon(d.npc)) return;
      if (!this.npcs.has(d.entity)) this.#arrived(pos, at);
      this.npcs.set(d.entity, { entity: d.entity, npc: d.npc, pos, at });
    }
    // Whether it was one of the monsters around.
    gone(d) {
      return this.npcs.delete(d.entity);
    }
    // You moved far: who was around is gone, but for what came with you.
    #left(at) {
      for (const [entity, n] of this.npcs) if (n.at < at - MOVE_KEEP_MS) this.npcs.delete(entity);
      this.arrivals = this.arrivals.filter((a) => a.at >= at - MOVE_KEEP_MS);
    }
    mapLoad(d, at) {
      this.#left(at);
      if (d.map > 0) this.mapId = d.map;
      const pos = position(d);
      this.me = pos ? { pos, at } : null;
    }
    teleport(d, at) {
      const pos = position(d);
      if (!pos) return;
      this.#left(at);
      this.me = { pos, at };
    }
    // A record the meter passed on as yours.
    here(d, at) {
      const pos = position(d);
      if (pos) this.#placed(pos, at);
    }
    #placed(pos, at) {
      if (this.me && this.me.at > at) return;
      this.me = { pos, at };
      for (const [entity, n] of this.npcs) if (metres(pos, n.pos) > FORGET_M) this.npcs.delete(entity);
    }
    // Where you are: { pos, at, estimated }. Your last exact position while
    // fresh; then, with enough come into view since, their middle moved back
    // toward it; else the last exact one, however old. Null when nothing is known.
    where(now) {
      const me = this.me;
      if (me && now - me.at <= EXACT_MS) return { ...me, estimated: false };
      const recent = this.arrivals.filter((a) => (!me || a.at > me.at) && now - a.at <= ARRIVALS_MS
        && (!me || metres(a.pos, me.pos) <= REACH_M + (REACH_M_PER_S * (a.at - me.at)) / 1000));
      if (recent.length < ARRIVALS_MIN) return me ? { ...me, estimated: false } : null;
      const mid = [0, 1, 2].map((i) => recent.reduce((s, a) => s + a.pos[i], 0) / recent.length);
      let pos = mid;
      if (me) {
        const dx = me.pos[0] - mid[0];
        const dy = me.pos[1] - mid[1];
        const len = Math.hypot(dx, dy);
        const back = Math.min(BACK_M * 100, len);
        if (len > 0) pos = [mid[0] + (dx / len) * back, mid[1] + (dy / len) * back, mid[2]];
      }
      return { pos, at: recent[recent.length - 1].at, estimated: true };
    }
    // The monsters with their distance and way from you, nearest first.
    around() {
      if (!this.me) return [];
      const me = this.me.pos;
      return [...this.npcs.values()]
        .map((n) => ({ ...n, m: metres(me, n.pos), deg: bearing(me, n.pos) }))
        .filter((n) => n.m <= FORGET_M)
        .sort((a, b) => a.m - b.m);
    }
  }

  globalThis.PetNearby = { MOVE_KEEP_MS, FORGET_M, EXACT_MS, toFloat, position, metres, bearing, compass, Field };
})();
