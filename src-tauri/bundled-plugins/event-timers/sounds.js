// Alert sounds, made on the spot with the Web Audio API (no sound files): the
// Hidden Cube Alert's five, four more, and eight built on FM synthesis and a
// reverb. Each is a list of notes:
// [frequency Hz, start s, length s, wave, volume, extras?].
// The extras, all optional: attack (s, from 0.02); glide (Hz to slide to);
// detune (cents); lp/lpEnd (a low-pass cut-off, Hz, closing from lp to lpEnd
// as the note fades); hp (a high-pass cut-off, Hz); fm: [ratio, index,
// indexEnd] (a sine modulating the note's pitch, at ratio × its frequency,
// its depth falling from index to indexEnd × the frequency: bells, tines,
// electric piano); wet (0-1, how much goes to the reverb). A wave of
// "noise" plays white noise.

// Bell-like FM, inharmonic (non-integer ratios ring like struck metal).
const fmNote = (f, at, length, volume, fm, extra = {}) => [f, at, length, "sine", volume, { attack: 0.003, fm, ...extra }];
// A struck bar or tine: the note, and an overtone that dies at once.
const struck = (f, at, length, volume, overtone, wet) => [
  [f, at, length, "sine", volume, { attack: 0.002, wet }],
  [f * overtone, at, Math.min(0.12, length), "sine", volume * 0.5, { attack: 0.001, wet }],
];

const SOUNDS = {
  chime: [[880, 0, 0.45, "sine", 0.25], [1320, 0.16, 0.5, "sine", 0.25]],
  bell: [[660, 0, 1.4, "sine", 0.28], [1320, 0, 0.9, "sine", 0.1], [1980, 0, 0.5, "sine", 0.05]],
  sparkle: [
    [1047, 0, 0.18, "triangle", 0.2], [1319, 0.08, 0.18, "triangle", 0.2],
    [1568, 0.16, 0.18, "triangle", 0.2], [2093, 0.24, 0.35, "triangle", 0.2],
  ],
  ping: [[1760, 0, 0.3, "sine", 0.22], [1760, 0.35, 0.3, "sine", 0.14]],
  soft: [[523, 0, 0.6, "sine", 0.18], [659, 0.22, 0.7, "sine", 0.16]],
  // A low struck gong: a deep note with its overtones, dying away slowly.
  gong: [[98, 0, 2.6, "sine", 0.32], [196, 0, 1.8, "sine", 0.12], [294, 0, 1.2, "triangle", 0.06], [415, 0.02, 0.8, "sine", 0.04]],
  // Two rising horn calls.
  horn: [[294, 0, 0.32, "sawtooth", 0.08], [392, 0.34, 0.55, "sawtooth", 0.09], [392, 0.34, 0.55, "sine", 0.12]],
  // A quick rising arpeggio, plucked.
  harp: [
    [523, 0, 0.5, "triangle", 0.18], [659, 0.07, 0.5, "triangle", 0.18], [784, 0.14, 0.5, "triangle", 0.18],
    [1047, 0.21, 0.6, "triangle", 0.18], [1319, 0.28, 0.8, "triangle", 0.16],
  ],
  // Two-tone alarm, three times: hard to miss.
  alarm: [
    [988, 0, 0.14, "square", 0.07], [784, 0.16, 0.14, "square", 0.07],
    [988, 0.32, 0.14, "square", 0.07], [784, 0.48, 0.14, "square", 0.07],
    [988, 0.64, 0.14, "square", 0.07], [784, 0.8, 0.14, "square", 0.07],
  ],
  // Two glassy bell strikes, a fifth apart, ringing into the room.
  crystal: [
    fmNote(1318.5, 0, 1.6, 0.2, [3.5, 4, 0.2], { wet: 0.45 }),
    fmNote(1975.5, 0.13, 1.8, 0.16, [3.5, 4, 0.2], { wet: 0.45 }),
  ],
  // A rising marimba triad: wooden bars, their 4th partial gone at once.
  marimba: [
    ...struck(784, 0, 0.5, 0.32, 3.93, 0.2),
    ...struck(988, 0.1, 0.5, 0.3, 3.93, 0.2),
    ...struck(1175, 0.2, 0.7, 0.3, 3.93, 0.2),
  ],
  // A kalimba phrase: thumb-piano tines, their overtone at ~6.3×.
  kalimba: [
    ...struck(880, 0, 1.1, 0.3, 6.3, 0.3),
    ...struck(1047, 0.14, 1.1, 0.28, 6.3, 0.3),
    ...struck(1319, 0.28, 1.4, 0.3, 6.3, 0.3),
  ],
  // An electric-piano "ding-dong": FM at 1:1 for the body, a high tine on top.
  epiano: [
    fmNote(659.3, 0, 1.2, 0.24, [1, 2.2, 0.3], { wet: 0.25 }),
    fmNote(659.3, 0, 0.25, 0.05, [14, 1.2, 0.1], { wet: 0.25 }),
    fmNote(523.3, 0.32, 1.5, 0.24, [1, 2.2, 0.3], { wet: 0.25 }),
    fmNote(523.3, 0.32, 0.25, 0.05, [14, 1.2, 0.1], { wet: 0.25 }),
  ],
  // A sonar ping, and its echo coming back.
  sonar: [
    [1480, 0, 1.4, "sine", 0.3, { attack: 0.004, glide: 1420, wet: 0.6 }],
    [1480, 0.55, 1.0, "sine", 0.1, { attack: 0.004, glide: 1420, wet: 0.8 }],
  ],
  // "Quest complete": a bright rising run, then the chord held.
  fanfare: [
    ...[523.3, 659.3, 784, 1046.5].map((f, i) => [f, i * 0.07, 0.16, "square", 0.06, { attack: 0.004, lp: 4000, wet: 0.2 }]),
    ...[523.3, 659.3, 784, 1046.5].map((f) => [f, 0.3, 0.9, "sawtooth", 0.05, { attack: 0.01, lp: 3500, lpEnd: 900, wet: 0.3 }]),
    [1046.5, 0.3, 0.9, "sine", 0.12, { attack: 0.01, wet: 0.3 }],
  ],
  // A deep war horn, swelling in, for a boss.
  warhorn: [
    [104, 0, 1.5, "sawtooth", 0.14, { attack: 0.18, glide: 110, detune: -8, lp: 900, lpEnd: 500, wet: 0.4 }],
    [104, 0, 1.5, "sawtooth", 0.14, { attack: 0.18, glide: 110, detune: 8, lp: 900, lpEnd: 500, wet: 0.4 }],
    [208, 0.05, 1.4, "square", 0.04, { attack: 0.2, glide: 220, lp: 1400, lpEnd: 600, wet: 0.4 }],
  ],
  // Taiko drums: two quick hits and a big one.
  taiko: [
    ...[[0, 0.55], [0.17, 0.5], [0.42, 0.85]].flatMap(([at, v]) => [
      [92, at, 0.55, "sine", v, { attack: 0.002, glide: 48, wet: 0.3 }],
      [0, at, 0.08, "noise", v * 0.5, { attack: 0.001, lp: 900, lpEnd: 200, wet: 0.3 }],
    ]),
  ],
};

// How long a sound lasts, in seconds (its last note's end), for repeats.
const soundLength = (name) => Math.max(0, ...(SOUNDS[name] || []).map(([, start, length]) => start + length));

// One context for every alert. WebKitGTK (the meter on Linux) starts a new
// context suspended, its clock standing still until it is resumed, so it is
// resumed before each sound; WebView2 (Windows) starts it running.
//
// The resume is not awaited: in a hidden window WebKitGTK's resume() waits
// until the page is used, so an alert that waited for it stayed silent until
// the window was opened. Scheduled at once, the notes play as it resumes.
let audio = null;
// The notes still sounding, so a mute can cut them off.
const sounding = new Set();

// The way out: every sound goes through one limiter, so a loud one comes out
// dense instead of clipping (the quiet ones never reach it), and a reverb the
// notes send to by their "wet".
let output = null;
function outputs(ctx) {
  if (output) return output;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.12;
  limiter.connect(ctx.destination);
  // A small hall: stereo noise dying away over 1.8 s.
  const reverb = ctx.createConvolver();
  const length = Math.floor(ctx.sampleRate * 1.8);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
  }
  reverb.buffer = impulse;
  const reverbLevel = ctx.createGain();
  reverbLevel.gain.value = 0.5;
  reverb.connect(reverbLevel).connect(limiter);
  output = { limiter, reverb };
  return output;
}

// White noise, made once, for the notes whose wave is "noise".
let noiseBuffer = null;
function noise(ctx) {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  return src;
}

async function playSound(name) {
  const notes = SOUNDS[name];
  if (!notes) return;
  try {
    audio ||= new AudioContext();
    if (audio.state !== "running") audio.resume().catch(() => {});
    const ctx = audio;
    const out = outputs(ctx);
    for (const [freq, start, length, wave, volume, extra = {}] of notes) {
      const at = ctx.currentTime + start;
      const sources = [];
      let osc;
      if (wave === "noise") {
        osc = noise(ctx);
      } else {
        osc = ctx.createOscillator();
        osc.type = wave;
        osc.frequency.setValueAtTime(freq, at);
        if (extra.glide) osc.frequency.exponentialRampToValueAtTime(extra.glide, at + length);
        if (extra.detune) osc.detune.value = extra.detune;
        if (extra.fm) {
          const [ratio, index, indexEnd = index] = extra.fm;
          const mod = ctx.createOscillator();
          const depth = ctx.createGain();
          mod.frequency.value = freq * ratio;
          depth.gain.setValueAtTime(index * freq, at);
          depth.gain.exponentialRampToValueAtTime(Math.max(0.001, indexEnd * freq), at + length);
          mod.connect(depth).connect(osc.frequency);
          sources.push(mod);
        }
      }
      sources.push(osc);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(volume, at + (extra.attack ?? 0.02));
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      let tail = osc;
      if (extra.lp) {
        const filter = ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(extra.lp, at);
        filter.frequency.exponentialRampToValueAtTime(extra.lpEnd ?? extra.lp, at + length);
        tail = tail.connect(filter);
      }
      if (extra.hp) {
        const filter = ctx.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = extra.hp;
        tail = tail.connect(filter);
      }
      tail.connect(gain).connect(out.limiter);
      if (extra.wet) {
        const send = ctx.createGain();
        send.gain.value = extra.wet;
        gain.connect(send).connect(out.reverb);
      }
      for (const src of sources) {
        src.start(at);
        src.stop(at + length + 0.05);
        sounding.add(src);
        src.onended = () => sounding.delete(src);
      }
    }
  } catch {}
}

// Silence every note still playing or waiting to (an alert's Mute).
function stopSounds() {
  for (const osc of sounding) {
    try {
      osc.stop();
    } catch {}
  }
  sounding.clear();
}
