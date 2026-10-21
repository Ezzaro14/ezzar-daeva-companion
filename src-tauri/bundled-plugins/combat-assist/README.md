# Combat Assist

Bars of the skills and buffs you pick, placed anywhere over the game.

- **Skills** count down their cooldown, darkened by a sweep, and glow when ready.
- **Buffs** show the time they have left as a ring (or a fill), and their stacks; dimmed while they are not on you.
- Icons are **square**, **round** or **bars**, in a **row** or **stacked**, at the size you pick.
- A bar can **hide out of combat**.

Up to 8 bars of 16 icons each. Unlock and drag a bar to move it; lock to let clicks through to the game. Double-click a bar to open this window.

## Cooldowns

The game sends no record when a skill goes on cooldown, so cooldowns are learnt from use: the time between two casts of a skill, the shortest seen (one much shorter than the rest is taken as a cast that another skill sped up, and marked ▼). Use a skill twice on cooldown and its bar knows it. A cooldown you type in seconds wins over the learnt one.

Comes with the meter; needs the `feed:combat` permission (plugins/bundled.rs).
