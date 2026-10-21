# PvP Overlay

The players you trade blows with, in a widget you place anywhere over the game:

- each opponent's **class**, **name**, **HP**, the damage **you dealt** them and **took** from them; the ones you **defeated** struck through;
- the session's **time**, **kills** and **deaths** and your **biggest burst** (the most damage in any 5 seconds).

A session ends a minute after the last blow and is saved, with each opponent's skills (yours on them, theirs on you) and the damage per second over time, for the whole session or one opponent. A sound plays when you defeat someone.

A player is an opponent when you trade blows and they are not in your party. The game sends a heal on another player as the same record as a blow, so a heal on a player outside your party lists them too.

Comes with the meter; needs the `feed:combat` permission (plugins/bundled.rs).
