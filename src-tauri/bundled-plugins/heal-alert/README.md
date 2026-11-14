# Heal Alert

For Clerics. Each party member's HP as a bar. The moment one drops under 60%
(or the level you pick: 40 to 80%), a voice saying "Heal!" and a red banner
over the game ("Heal! 2: 43%"), which goes again on its own once everyone is
back over the line.

The banner shows on the overlay, in a widget you place under **Edit layout**
(double-click it to open this page). **Over the game** says what it shows: the
banner on an alert (the default), every member's HP bar and the banner, or
nothing (the sound only).

Each member rings once, and not again until they are back over the line:
staying low, or dropping lower, is no new alert. A member at 0 HP is down,
not someone to heal: no alert. Several dropping at once make one sound.

No names: plugins only get numbers. Members are numbered in the order the
plugin first saw them.

Only a Cleric is alerted (with `events:character`): on another class the bars
still show, with no alert. Until the meter knows your class (at login, or
from your skills if it started mid-game) there is no alert either.

⚙: the line, what shows over the game, and the sound: the voice, an alarm, a chime, a ping, your own
file (any audio file up to 600 KB, kept by the plugin), or none; and its volume.

The voice is made with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
(voice `af_nicole`; the model and its voices are Apache 2.0).

## What it reads

- `1B 92`, a party member's HP and MP: the member, current HP, max HP
  (varints). The game sends it about once a second for each party member
  other than you; a member silent for 10 s has left.

Checked against a capture from 2026-10-18 (02:23, a party of five): four
members, about one record a second each, never your own.

From A2Tools-Plugins' Heal Alert 1.2.4 by Nullception (GPL-3.0); the overlay widget is Ezzar's Daeva Companion's.
