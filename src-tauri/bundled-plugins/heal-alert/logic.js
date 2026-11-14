// Heal Alert's rules, without the page: each party member's HP, and when one
// has just dropped under the line. plugin.js uses them; a test can load this
// file alone.
(() => {
  // `1b 92` comes about once a second for each party member but you.
  // Silent this long, a member has left the party or the map.
  const GONE_MS = 10_000;

  class Party {
    constructor() {
      this.members = new Map(); // id -> { n, hp, max, pct, at, low }
      this.seen = 0;
    }
    // One `1b 92`. True when this member has just gone under `line` (%):
    // alive, and not already under it. Each member rings once, until back
    // over the line. A member at 0 HP is down, not to heal.
    update(d, at, line) {
      if (!d || !(d.max > 0)) return false;
      let m = this.members.get(d.member);
      if (!m) this.members.set(d.member, (m = { n: ++this.seen, low: false }));
      m.hp = Math.min(d.hp, d.max);
      m.max = d.max;
      m.pct = (m.hp * 100) / d.max;
      m.at = at;
      if (m.hp > 0 && m.pct < line && !m.low) return (m.low = true);
      if (m.hp === 0 || m.pct >= line) m.low = false;
      return false;
    }
    prune(now) {
      for (const [id, m] of this.members) if (now - m.at > GONE_MS) this.members.delete(id);
    }
    // Members in the order first seen.
    list() {
      return [...this.members.values()].sort((a, b) => a.n - b.n);
    }
    // Alive and under the line now.
    low(line) {
      return this.list().filter((m) => m.hp > 0 && m.pct < line);
    }
    clear() {
      this.members.clear();
    }
  }

  globalThis.HealLogic = { Party, GONE_MS };
})();
