// Heal Alert: for Clerics, a sound and a banner the moment a party member's
// HP drops under the line, and each member's HP as a bar. In Ezzar's Daeva
// Companion the banner and the bars show over the game in a widget (the page
// itself is in the dashboard): "onScreen" says what it shows.
const { Party } = globalThis.HealLogic;
const $ = (sel, root = document) => root.querySelector(sel);

// Events older than this are the meter's replay of what came before the
// window opened: no use for what is on now.
const STALE_MS = 5_000;
// The sound at most this often, however many members drop at once.
const SOUND_GAP_MS = 1_500;
// volume: every sound's loudness, 0-100 %.
// onScreen: over the game, "alert" (the banner, on an alert), "bars" (every
// member's HP, and the banner) or "off" (the sound only).
const prefs = { line: 60, sound: "voice", volume: 100, onScreen: "alert" };
// Your own sound, as the file's bytes in base64 and its name.
let own = null; // { name, data }
// Most a file may be: the plugin's storage holds 1 MB.
const OWN_MAX = 600 * 1024;
const party = new Party();

// Only a Cleric is alerted. The meter names classes in Korean; null until
// it knows (it learns at login, or from your skills when started mid-game).
const CLERIC = "치유성";
let who = null;
let cleric = null;
a2.on("character", (c) => {
  const key = c?.name ? `${c.name}@${c.serverId}` : null;
  if (key && who && key !== who) party.clear();
  if (key) who = key;
  cleric = c?.class ? c.class === CLERIC : null;
  update();
});

let lastSound = 0;
a2.on("decoded:party-hp", (d, meta) => {
  const at = meta.at || Date.now();
  if (Date.now() - at > STALE_MS) return;
  const dropped = party.update(d, at, prefs.line);
  if (dropped && cleric) alert();
  update();
});

// ── Alert ──────────────────────────────────────────────────────────────────
function alert() {
  const now = Date.now();
  if (now - lastSound >= SOUND_GAP_MS) {
    lastSound = now;
    playSound(prefs.sound);
  }
}

// ── Over the game ──────────────────────────────────────────────────────────
// The widget: open while AION2 is (the meter says so in "game"), unless the
// player wants nothing on screen. Sized for the banner and six members.
const WIDGET = "party";
const WIDGET_SIZE = { width: 240, height: 150, label: "Heal Alert" };
let gameOpen = false;
let widgetOpen = false;
let lastSent = "";
async function placeWidget() {
  const want = gameOpen && prefs.onScreen !== "off";
  if (want === widgetOpen) return;
  widgetOpen = want;
  lastSent = "";
  if (want) await a2.widgets.open(WIDGET, WIDGET_SIZE).catch(() => (widgetOpen = false));
  else await a2.widgets.close(WIDGET).catch(() => {});
  update();
}
a2.on("game", (d) => {
  gameOpen = !!d?.running;
  placeWidget();
});
// A double-click on the widget opens this page.
a2.on("widget-message", ({ data } = {}) => {
  if (data?.open) Promise.resolve(a2.window?.show?.()).catch(() => {});
});
function sendWidget(members, low) {
  if (!widgetOpen) return;
  const scene = {
    banner: low.length ? bannerText(low) : "",
    bars: prefs.onScreen === "bars",
    members: members.map((m, i) => ({
      n: i + 1,
      pct: m.pct,
      state: m.hp === 0 ? "down" : m.pct < prefs.line ? "low" : m.pct < prefs.line + 20 ? "mid" : "",
    })),
  };
  const key = JSON.stringify(scene);
  if (key === lastSent) return;
  lastSent = key;
  a2.widgets.send(WIDGET, scene).catch(() => {});
}
const bannerText = (low) => `Heal! ${low.map((m) => `${party.list().indexOf(m) + 1}: ${Math.round(m.pct)}%`).join(" · ")}`;

// ── Drawing ────────────────────────────────────────────────────────────────
function update() {
  party.prune(Date.now());
  const members = party.list();
  const low = cleric ? party.low(prefs.line) : [];
  const ul = $(".members");
  while (ul.children.length < members.length) {
    const li = document.createElement("li");
    li.innerHTML = '<span class="n"></span><span class="bar"><span class="fill"></span></span><span class="pct"></span>';
    ul.append(li);
  }
  while (ul.children.length > members.length) ul.lastChild.remove();
  members.forEach((m, i) => {
    const li = ul.children[i];
    const pct = Math.round(m.pct);
    $(".n", li).textContent = i + 1;
    $(".fill", li).style.width = `${m.pct}%`;
    $(".pct", li).textContent = m.hp > 0 ? `${pct}%` : "down";
    li.className = m.hp === 0 ? "down" : m.pct < prefs.line ? "low" : m.pct < prefs.line + 20 ? "mid" : "";
  });
  $(".status").textContent =
    cleric === false ? "Not a Cleric: no alerts"
    : cleric === null ? "Waiting to learn your class"
    : members.length ? `Alert under ${prefs.line}%`
    : "No party members seen";
  $(".banner").hidden = !low.length;
  $(".banner").textContent = low.length ? bannerText(low) : "";
  sendWidget(members, low);
}

// ── Sounds ─────────────────────────────────────────────────────────────────
// Notes made with Web Audio, the voice (voice.js), or your own file. The page
// may load no audio files, so the clips are decoded from their bytes here.
const SOUNDS = {
  alarm: [
    [988, 0, 0.14, "square", 0.07], [784, 0.16, 0.14, "square", 0.07],
    [988, 0.32, 0.14, "square", 0.07], [784, 0.48, 0.14, "square", 0.07],
  ],
  chime: [[880, 0, 0.45, "sine", 0.25], [1320, 0.16, 0.5, "sine", 0.25]],
  ping: [[1760, 0, 0.3, "sine", 0.22], [1760, 0.35, 0.3, "sine", 0.14]],
};
let audio = null;
// Every sound goes out through one gain, the Volume setting: squared, so the
// slider follows how loud it sounds.
let out = null;
// An AudioContext is an audio engine of its own: on Linux a GStreamer
// pipeline with its own thread and buffers, some 40 MB, kept for the whole
// run (2026-10-29). Closed once nothing has played for IDLE_MS, made again
// for the next sound; decoded clips (AudioBuffers) work in the new one.
const IDLE_MS = 30_000;
let idleClose = null;
function audioUsed() {
  clearTimeout(idleClose);
  idleClose = setTimeout(() => {
    const ctx = audio;
    audio = null;
    out = null;
    ctx?.close().catch(() => {});
  }, IDLE_MS);
}
const gainOf = (percent) => Math.pow(Math.max(0, Math.min(100, Number(percent) || 0)) / 100, 2);
function setVolume() {
  if (out) out.gain.value = gainOf(prefs.volume);
}
const clips = new Map(); // base64 -> Promise<AudioBuffer>
function clip(base64) {
  if (!clips.has(base64)) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    clips.set(base64, audio.decodeAudioData(bytes.buffer));
  }
  return clips.get(base64);
}
function playSound(name) {
  const data = name === "voice" ? globalThis.HEAL_VOICE : name === "own" ? own?.data : null;
  const notes = SOUNDS[name];
  if (!data && !notes) return;
  try {
    audio ||= new AudioContext();
    audioUsed();
    if (!out) {
      out = audio.createGain();
      out.connect(audio.destination);
      setVolume();
    }
    // Not awaited: in a hidden window WebKitGTK's resume() waits for the page
    // to be used, and a sound that waited for it stayed silent.
    if (audio.state !== "running") audio.resume().catch(() => {});
    if (data) {
      clip(data)
        .then((buffer) => {
          const src = audio.createBufferSource();
          src.buffer = buffer;
          src.connect(out);
          src.start();
        })
        // A file it can't play: the alarm, so the alert is never silent.
        .catch(() => playSound("alarm"));
      return;
    }
    for (const [freq, start, length, wave, volume] of notes) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = wave;
      osc.frequency.value = freq;
      const t = audio.currentTime + start;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
      osc.connect(gain).connect(out);
      osc.start(t);
      osc.stop(t + length + 0.05);
    }
  } catch (e) {
    console.warn(e);
  }
}

// ── Settings ───────────────────────────────────────────────────────────────
$(".gear").addEventListener("click", () => {
  $(".settings").hidden = !$(".settings").hidden;
});
$(".line").addEventListener("change", (e) => {
  prefs.line = Number(e.target.value);
  a2.storage.set("prefs", prefs).catch(() => {});
  update();
});
$(".sound").addEventListener("change", (e) => {
  prefs.sound = e.target.value;
  a2.storage.set("prefs", prefs).catch(() => {});
  showOwn();
  if (prefs.sound === "own" && !own) $(".file").click();
});
function showOwn() {
  $(".ownRow").hidden = prefs.sound !== "own";
  $(".ownName").textContent = own ? own.name : "none yet";
}
$(".choose").addEventListener("click", () => $(".file").click());
$(".file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > OWN_MAX) {
    $(".ownName").textContent = `Too big (${Math.round(OWN_MAX / 1024)} KB at most)`;
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    own = { name: file.name, data: String(reader.result).split(",")[1] || "" };
    showOwn();
    a2.storage.set("own", own).catch(() => ($(".ownName").textContent = "Could not keep the file"));
    playSound("own");
  };
  reader.readAsDataURL(file);
});
$(".volume").addEventListener("input", (e) => {
  prefs.volume = Number(e.target.value);
  setVolume();
  a2.storage.set("prefs", prefs).catch(() => {});
});
// Heard where the slider is let go.
$(".volume").addEventListener("change", () => playSound(prefs.sound));
$(".test").addEventListener("click", () => playSound(prefs.sound));
$(".onScreen").addEventListener("change", (e) => {
  prefs.onScreen = e.target.value;
  a2.storage.set("prefs", prefs).catch(() => {});
  lastSent = "";
  placeWidget();
  update();
});
a2.on("compact", (on) => document.body.classList.toggle("compact", !!on));

(async () => {
  const [savedPrefs, savedOwn] = await Promise.all([a2.storage.get("prefs").catch(() => null), a2.storage.get("own").catch(() => null)]);
  Object.assign(prefs, savedPrefs || {});
  // Saved by A2 Tools' version: "show the window on an alert" off was the
  // sound alone.
  if (!["alert", "bars", "off"].includes(prefs.onScreen)) prefs.onScreen = savedPrefs?.showWindow === false ? "off" : "alert";
  delete prefs.showWindow;
  if (savedOwn?.data) own = savedOwn;
  $(".line").value = String(prefs.line);
  $(".sound").value = prefs.sound;
  $(".volume").value = String(prefs.volume);
  $(".onScreen").value = prefs.onScreen;
  showOwn();
  update();
  a2.ready();
  setInterval(update, 500);
})();
