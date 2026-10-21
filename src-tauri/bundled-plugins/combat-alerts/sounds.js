// Alert sounds made with the Web Audio API, no sound files: a few short
// tones from Event Timers' set. Each note: [Hz, start s, length s, wave, volume].
const SOUNDS = {
  chime: [[880, 0, 0.45, "sine", 0.25], [1320, 0.16, 0.5, "sine", 0.25]],
  ping: [[1760, 0, 0.3, "sine", 0.22], [1760, 0.35, 0.3, "sine", 0.14]],
  soft: [[523, 0, 0.6, "sine", 0.18], [659, 0.22, 0.7, "sine", 0.16]],
  alarm: [
    [988, 0, 0.14, "square", 0.07], [784, 0.16, 0.14, "square", 0.07],
    [988, 0.32, 0.14, "square", 0.07], [784, 0.48, 0.14, "square", 0.07],
  ],
  thud: [[140, 0, 0.35, "triangle", 0.4], [90, 0.02, 0.4, "sine", 0.35]],
  rise: [[440, 0, 0.12, "triangle", 0.2], [660, 0.1, 0.12, "triangle", 0.2], [990, 0.2, 0.3, "triangle", 0.2]],
};
const SOUND_NAMES = { none: "No sound", chime: "Chime", ping: "Ping", soft: "Soft", alarm: "Alarm", thud: "Thud", rise: "Rise" };

let audio = null;
function playSound(name, volume = 0.8) {
  const notes = SOUNDS[name];
  if (!notes || volume <= 0) return;
  try {
    audio ||= new AudioContext();
    if (audio.state === "suspended") audio.resume();
    const t0 = audio.currentTime + 0.02;
    for (const [f, at, len, wave, vol] of notes) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = wave;
      osc.frequency.value = f;
      const peak = vol * volume;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(peak, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.05);
    }
  } catch (e) {
    console.warn("sound", e);
  }
}
