import type { GameContext, GameSystem, AudioBus } from '../core/types'
import { TUNING } from '../plane/flight'

/**
 * Audio.ts — the game's entire sound world, synthesized live with WebAudio.
 * No asset files: every SFX is a short procedural envelope, and the ambient
 * beds (engine, wind, music pad + melody) are tiny oscillator/noise graphs.
 *
 * Returns BOTH a GameSystem (drives the engine bed from the live flight speed)
 * and an AudioBus impl (main.ts assigns it to ctx.audio so every other system
 * can call ctx.audio.play(...) / ctx.audio.setEngine(...)).
 *
 * iOS / autoplay: an AudioContext starts "suspended" until a user gesture.
 * We register one-shot pointerdown/keydown/touchstart listeners that call
 * unlock(); unlock() is idempotent + safe to call from anywhere.
 *
 * Mobile-perf:
 *  - The whole graph is built ONCE on first unlock (lazy), not at import.
 *  - update() does only number math + a handful of AudioParam ramps — it
 *    allocates NOTHING per frame (no closures, no objects, no arrays).
 *  - SFX voices are short-lived nodes that disconnect themselves on 'ended',
 *    so the graph never grows unbounded; a hard voice cap drops the spill.
 *  - One shared, pre-rendered noise buffer feeds wind + noisy SFX.
 *  - The melody re-schedules itself on a coarse self-rescheduling timer, not
 *    in the per-frame path, so it costs nothing during flight.
 *
 * The "engine" is now THREE layered voices for a believable propeller feel:
 *   1. a low sub thump (sine an octave below the rumble) for weight,
 *   2. two detuned saws (the body of the rumble) through a moving lowpass,
 *   3. a "prop whir" — a fast amplitude tremolo whose rate AND pitch climb
 *      with speed, the part your ear reads as "the propeller spinning faster".
 */

// ---- cozy tuning (module-local; never exported, keeps the contract clean) ----
const MASTER_GAIN = 0.82
const MUSIC_GAIN = 0.1 // a whisper-quiet pad, never competes with SFX
const MELODY_GAIN = 0.06 // softer still — a few wandering notes, not a tune
const WIND_GAIN_MAX = 0.17
const ENGINE_GAIN_MIN = 0.05
const ENGINE_GAIN_MAX = 0.2
const ENGINE_HZ_MIN = 60 // idle/cruise rumble (fundamental of the saws)
const ENGINE_HZ_MAX = 148 // boost
const ENGINE_FILTER_MIN = 400
const ENGINE_FILTER_MAX = 1700
const SUB_GAIN_MIN = 0.05
const SUB_GAIN_MAX = 0.13
const WHIR_GAIN_MIN = 0.012
const WHIR_GAIN_MAX = 0.05
const WHIR_HZ_MIN = 22 // tremolo rate at idle (per second) — felt, not pitched
const WHIR_HZ_MAX = 64 // tremolo rate at boost
const SFX_VOICE_CAP = 18 // max concurrent SFX voices (mobile-safe)
const PARAM_GLIDE = 0.09 // seconds for engine/wind param ramps (smooth, dt-free)

// A warm C-major add9 pad chord (Hz). Cozy, open, never dissonant.
const PAD_NOTES = [130.81, 196.0, 261.63, 392.0] // C3 G3 C4 G4

// A gentle pentatonic well for the wandering melody (C major pentatonic, Hz).
// Picked at random each phrase — pentatonic guarantees it's always consonant.
const MELODY_NOTES = [
  392.0, // G4
  440.0, // A4
  523.25, // C5
  587.33, // D5
  659.25, // E5
  783.99, // G5
]

// Map an external sound name (whatever a caller passes) to a synth recipe key.
// Covers BOTH the names this codebase actually emits (collect/boost/fire/
// levelup/splat) and the names listed in the design brief (box/diamond/lantern/
// ring/paint/splash) so no caller is ever silent.
type Recipe =
  | 'collect'
  | 'diamond'
  | 'lantern'
  | 'ring'
  | 'levelup'
  | 'boost'
  | 'paint'
  | 'splash'
  | 'crash'

function recipeFor(name: string): Recipe {
  switch (name) {
    case 'box':
    case 'collect':
      return 'collect'
    case 'diamond':
    case 'gem':
      return 'diamond'
    case 'lantern':
      return 'lantern'
    case 'ring':
      return 'ring'
    case 'levelup':
    case 'unlock':
    case 'vehicleUnlock':
    case 'questComplete':
      return 'levelup'
    case 'boost':
      return 'boost'
    case 'fire':
    case 'paint':
    case 'paintball':
      return 'paint'
    case 'splat':
    case 'splash':
      return 'splash'
    case 'crash':
      return 'crash'
    default:
      return 'collect'
  }
}

export function createAudioSystem(): { system: GameSystem; bus: AudioBus } {
  // --- lazily-created graph (null until first unlock) ---
  let ctxA: AudioContext | null = null
  let master: GainNode | null = null
  let comp: DynamicsCompressorNode | null = null

  // engine bed — three layers
  let engGain: GainNode | null = null // overall rumble-bus level
  let engFilter: BiquadFilterNode | null = null
  let engOscA: OscillatorNode | null = null
  let engOscB: OscillatorNode | null = null
  let subOsc: OscillatorNode | null = null // octave-down weight
  let subGain: GainNode | null = null
  let whirOsc: OscillatorNode | null = null // carrier for the prop whir
  let whirGain: GainNode | null = null // its (DC-offset) output level
  let whirLfo: OscillatorNode | null = null // tremolo that "chops" the whir
  let whirLfoGain: GainNode | null = null
  let whirDepth: GainNode | null = null // tremolo depth → whirGain.gain

  // wind bed
  let windGain: GainNode | null = null
  let windFilter: BiquadFilterNode | null = null
  let windSrc: AudioBufferSourceNode | null = null

  // music pad
  let musicGain: GainNode | null = null
  let padOscs: OscillatorNode[] = []
  let padFilter: BiquadFilterNode | null = null
  let padLfo: OscillatorNode | null = null
  let padLfoGain: GainNode | null = null

  // melody (a soft bell that re-triggers on a coarse timer)
  let melodyGain: GainNode | null = null
  let melodyTimer: ReturnType<typeof setTimeout> | null = null
  let melodyIdx = 0 // gentle random-walk index into MELODY_NOTES

  // sfx routing
  let sfxBus: GainNode | null = null
  let noiseBuf: AudioBuffer | null = null

  let started = false // graph built?
  let unlocked = false // resumed at least once?
  let activeVoices = 0 // live SFX voice count (for the cap)

  // Reusable gesture handler so we can add/remove it by reference (no realloc).
  const onGesture = () => doUnlock()

  // ----- noise buffer (shared by wind + noisy SFX) -----
  function makeNoise(ac: AudioContext): AudioBuffer {
    const len = Math.floor(ac.sampleRate * 1.5)
    const buf = ac.createBuffer(1, len, ac.sampleRate)
    const ch = buf.getChannelData(0)
    // brownish noise: integrate white noise a touch → softer, less hissy = cozy
    let last = 0
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1
      last = (last + 0.02 * white) / 1.02
      ch[i] = last * 3.2 + white * 0.25
    }
    return buf
  }

  // ----- build the persistent graph exactly once -----
  function buildGraph() {
    if (started) return
    const AC: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext
    if (!AC) return // very old / headless: stay silent, never throw
    const ac = new AC()
    ctxA = ac

    noiseBuf = makeNoise(ac)

    // master → soft compressor → speakers (compressor tames stacked SFX peaks)
    master = ac.createGain()
    master.gain.value = MASTER_GAIN
    comp = ac.createDynamicsCompressor()
    comp.threshold.value = -15
    comp.knee.value = 26
    comp.ratio.value = 3.2
    comp.attack.value = 0.004
    comp.release.value = 0.2
    master.connect(comp)
    comp.connect(ac.destination)

    // ===================== engine bed (3 layers) =====================
    // Shared output gain for the saw "body" of the rumble.
    engGain = ac.createGain()
    engGain.gain.value = 0.0001
    engGain.connect(master)

    // (2) body: two slightly-detuned saws through a moving lowpass.
    engFilter = ac.createBiquadFilter()
    engFilter.type = 'lowpass'
    engFilter.frequency.value = ENGINE_FILTER_MIN
    engFilter.Q.value = 5
    engFilter.connect(engGain)
    engOscA = ac.createOscillator()
    engOscA.type = 'sawtooth'
    engOscA.frequency.value = ENGINE_HZ_MIN
    engOscB = ac.createOscillator()
    engOscB.type = 'sawtooth'
    engOscB.frequency.value = ENGINE_HZ_MIN * 1.006 // beat for a thicker rumble
    engOscB.detune.value = 9
    engOscA.connect(engFilter)
    engOscB.connect(engFilter)
    engOscA.start()
    engOscB.start()

    // (1) sub: a clean sine an octave below for weight you feel more than hear.
    subOsc = ac.createOscillator()
    subOsc.type = 'sine'
    subOsc.frequency.value = ENGINE_HZ_MIN * 0.5
    subGain = ac.createGain()
    subGain.gain.value = 0.0001
    subOsc.connect(subGain)
    subGain.connect(master)
    subOsc.start()

    // (3) prop whir: a mid sine, amplitude-chopped by a fast LFO. The LFO rate
    // climbs with speed → the ear reads it as the propeller spinning faster.
    // Signal: whirOsc → whirGain (its level) → master.
    // Modulation: whirLfo → whirDepth → whirGain.gain (tremolo on top of a DC
    // base set by whirGain.gain.value).
    whirOsc = ac.createOscillator()
    whirOsc.type = 'triangle'
    whirOsc.frequency.value = 430 // airy, sits above the rumble
    whirGain = ac.createGain()
    whirGain.gain.value = WHIR_GAIN_MIN // DC base (audible floor)
    whirOsc.connect(whirGain)
    whirGain.connect(master)
    whirOsc.start()
    whirLfo = ac.createOscillator()
    whirLfo.type = 'sine'
    whirLfo.frequency.value = WHIR_HZ_MIN
    whirLfoGain = ac.createGain()
    whirLfoGain.gain.value = 1
    whirDepth = ac.createGain()
    whirDepth.gain.value = WHIR_GAIN_MIN * 0.9 // tremolo swing
    whirLfo.connect(whirLfoGain)
    whirLfoGain.connect(whirDepth)
    whirDepth.connect(whirGain.gain)
    whirLfo.start()

    // ===================== wind bed =====================
    // looping noise through a moving bandpass; rises with speed²
    windGain = ac.createGain()
    windGain.gain.value = 0.0001
    windFilter = ac.createBiquadFilter()
    windFilter.type = 'bandpass'
    windFilter.frequency.value = 650
    windFilter.Q.value = 0.6
    windSrc = ac.createBufferSource()
    windSrc.buffer = noiseBuf
    windSrc.loop = true
    windSrc.connect(windFilter)
    windFilter.connect(windGain)
    windGain.connect(master)
    windSrc.start()

    // ===================== ambient music pad =====================
    // detuned sines through a slow LFO-swept lowpass — a "breathing" chord
    musicGain = ac.createGain()
    musicGain.gain.value = 0.0001
    padFilter = ac.createBiquadFilter()
    padFilter.type = 'lowpass'
    padFilter.frequency.value = 760
    padFilter.Q.value = 1
    padFilter.connect(musicGain)
    musicGain.connect(master)
    padOscs = []
    for (let i = 0; i < PAD_NOTES.length; i++) {
      const o = ac.createOscillator()
      o.type = 'sine'
      o.frequency.value = PAD_NOTES[i]
      o.detune.value = (i % 2 === 0 ? -1 : 1) * (4 + i * 2) // gentle chorus
      const g = ac.createGain()
      g.gain.value = 0.22 / (i + 1.4) // gentle, top notes quieter than the root
      o.connect(g)
      g.connect(padFilter)
      o.start()
      padOscs.push(o)
    }
    // LFO sweeps the pad filter cutoff for a slow shimmer.
    padLfo = ac.createOscillator()
    padLfo.type = 'sine'
    padLfo.frequency.value = 0.045 // ~22s cycle
    padLfoGain = ac.createGain()
    padLfoGain.gain.value = 300 // +/- Hz on the cutoff
    padLfo.connect(padLfoGain)
    padLfoGain.connect(padFilter.frequency)
    padLfo.start()

    // ===================== melody bus =====================
    // A dedicated soft bus; individual notes are short bell voices scheduled
    // by scheduleMelody() on a self-rescheduling timer (not the frame loop).
    melodyGain = ac.createGain()
    melodyGain.gain.value = MELODY_GAIN
    melodyGain.connect(master)

    // ===================== shared SFX bus =====================
    sfxBus = ac.createGain()
    sfxBus.gain.value = 1
    sfxBus.connect(master)

    started = true
  }

  // ----- resume on first gesture (iOS/Safari autoplay policy) -----
  function doUnlock() {
    buildGraph()
    if (!ctxA) return
    if (ctxA.state !== 'running') {
      // resume() returns a promise; we don't await — fire-and-forget is fine.
      ctxA.resume().catch(() => {})
    }
    if (!unlocked) {
      unlocked = true
      const now = ctxA.currentTime
      // Fade the beds in once, smoothly (avoids a click on first gesture).
      if (musicGain) {
        musicGain.gain.cancelScheduledValues(now)
        musicGain.gain.setValueAtTime(0.0001, now)
        musicGain.gain.exponentialRampToValueAtTime(MUSIC_GAIN, now + 3.0)
      }
      if (engGain) {
        engGain.gain.cancelScheduledValues(now)
        engGain.gain.setValueAtTime(0.0001, now)
        engGain.gain.exponentialRampToValueAtTime(ENGINE_GAIN_MIN, now + 1.4)
      }
      if (subGain) {
        subGain.gain.cancelScheduledValues(now)
        subGain.gain.setValueAtTime(0.0001, now)
        subGain.gain.exponentialRampToValueAtTime(SUB_GAIN_MIN, now + 1.4)
      }
      // Kick off the wandering melody after the pad has settled in.
      if (!melodyTimer) melodyTimer = setTimeout(scheduleMelody, 4000)
      // remove the one-shot listeners — we only needed the first gesture
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('keydown', onGesture)
      window.removeEventListener('touchstart', onGesture)
    }
  }

  // ----- the wandering melody: one soft bell note, then reschedule -----
  // Lives entirely off a setTimeout chain so it never touches the frame loop.
  function scheduleMelody() {
    melodyTimer = null
    if (!ctxA || !melodyGain || ctxA.state !== 'running') {
      // try again shortly if the context isn't running yet
      melodyTimer = setTimeout(scheduleMelody, 3000)
      return
    }
    const ac = ctxA
    // gentle random walk through the pentatonic well (always consonant)
    const step = Math.floor(Math.random() * 3) - 1 // -1, 0, +1
    melodyIdx += step
    if (melodyIdx < 0) melodyIdx = 1
    else if (melodyIdx >= MELODY_NOTES.length) melodyIdx = MELODY_NOTES.length - 2
    const hz = MELODY_NOTES[melodyIdx]
    const t0 = ac.currentTime + 0.02
    // a soft FM-ish bell: fundamental + a quiet octave, slow attack, long tail
    spawnBell(ac, hz, t0, 1.8, 0.5)
    if (Math.random() < 0.5) spawnBell(ac, hz * 2, t0 + 0.04, 1.3, 0.22)
    // reschedule with a cozy, slightly random gap (musical breathing room)
    const gapMs = 2600 + Math.random() * 3600
    melodyTimer = setTimeout(scheduleMelody, gapMs)
  }

  // A single bell note routed to the melody bus (soft sine, exp tail).
  function spawnBell(
    ac: AudioContext,
    hz: number,
    at: number,
    dur: number,
    peak: number
  ) {
    if (!melodyGain) return
    const o = ac.createOscillator()
    o.type = 'sine'
    o.frequency.value = hz
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.06)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    o.connect(g)
    g.connect(melodyGain)
    spawnVoice([o, g], [o], g, at + dur + 0.05, /*toSfxBus=*/ false)
  }

  // ----- continuous engine/wind drive from normalized speed [0..1] -----
  function setEngine(s01: number) {
    if (!ctxA || !unlocked) return
    const s = s01 < 0 ? 0 : s01 > 1 ? 1 : s01
    const now = ctxA.currentTime

    // body: pitch + brightness + a little louder under boost
    const hz = ENGINE_HZ_MIN + (ENGINE_HZ_MAX - ENGINE_HZ_MIN) * s
    if (engOscA) engOscA.frequency.setTargetAtTime(hz, now, PARAM_GLIDE)
    if (engOscB) engOscB.frequency.setTargetAtTime(hz * 1.006, now, PARAM_GLIDE)
    if (engFilter)
      engFilter.frequency.setTargetAtTime(
        ENGINE_FILTER_MIN + (ENGINE_FILTER_MAX - ENGINE_FILTER_MIN) * s,
        now,
        PARAM_GLIDE
      )
    if (engGain) {
      const g = ENGINE_GAIN_MIN + (ENGINE_GAIN_MAX - ENGINE_GAIN_MIN) * s
      engGain.gain.setTargetAtTime(g, now, PARAM_GLIDE)
    }

    // sub: tracks the fundamental an octave down; swells a touch under boost
    if (subOsc) subOsc.frequency.setTargetAtTime(hz * 0.5, now, PARAM_GLIDE)
    if (subGain) {
      const sg = SUB_GAIN_MIN + (SUB_GAIN_MAX - SUB_GAIN_MIN) * s
      subGain.gain.setTargetAtTime(sg, now, PARAM_GLIDE)
    }

    // prop whir: tremolo RATE and the whir's own pitch climb with speed; its
    // base level + depth swell so the "spin" is felt more strongly at boost.
    if (whirLfo) {
      const rate = WHIR_HZ_MIN + (WHIR_HZ_MAX - WHIR_HZ_MIN) * s
      whirLfo.frequency.setTargetAtTime(rate, now, PARAM_GLIDE)
    }
    if (whirOsc) whirOsc.frequency.setTargetAtTime(360 + 260 * s, now, PARAM_GLIDE)
    if (whirGain) {
      const wg = WHIR_GAIN_MIN + (WHIR_GAIN_MAX - WHIR_GAIN_MIN) * s
      whirGain.gain.setTargetAtTime(wg, now, PARAM_GLIDE)
    }
    if (whirDepth) {
      const wd = (WHIR_GAIN_MIN + (WHIR_GAIN_MAX - WHIR_GAIN_MIN) * s) * 0.9
      whirDepth.gain.setTargetAtTime(wd, now, PARAM_GLIDE)
    }

    // wind: rises with the square of speed → quiet at cruise, present at boost
    if (windGain) {
      windGain.gain.setTargetAtTime(WIND_GAIN_MAX * s * s, now, PARAM_GLIDE)
    }
    if (windFilter) {
      windFilter.frequency.setTargetAtTime(450 + 1500 * s, now, PARAM_GLIDE)
    }
  }

  // ----- one SFX voice: built per call, self-cleaning on 'ended' -----
  function spawnVoice(
    nodes: AudioNode[],
    sources: { stop(at: number): void }[],
    sink: AudioNode,
    stopAt: number,
    toSfxBus = true
  ) {
    if (!ctxA) return
    const dest = toSfxBus ? sfxBus : melodyGain
    if (!dest) return
    // hard cap: if we're saturated, drop this voice (cheap, never queues up)
    if (activeVoices >= SFX_VOICE_CAP) {
      for (const n of nodes) {
        try {
          n.disconnect()
        } catch {
          /* not connected */
        }
      }
      return
    }
    activeVoices++
    sink.connect(dest)
    // schedule the auto-tear-down on the last source's 'ended'
    const last = sources[sources.length - 1] as any
    if (last && typeof last.onended !== 'undefined') {
      ;(last as AudioScheduledSourceNode).onended = () => {
        for (const n of nodes) {
          try {
            n.disconnect()
          } catch {
            /* already gone */
          }
        }
        activeVoices--
      }
    } else {
      activeVoices--
    }
    for (const s of sources) s.stop(stopAt)
  }

  // ----- the SFX synthesizer -----
  function play(name: string, opts?: { volume?: number; rate?: number }) {
    if (!started) buildGraph()
    if (!ctxA || !sfxBus || ctxA.state !== 'running') return
    const ac = ctxA
    const vol = opts?.volume ?? 1
    const rate = opts?.rate ?? 1
    const t0 = ac.currentTime
    const recipe = recipeFor(name)

    switch (recipe) {
      case 'collect': {
        // bright two-tone "blip" with a tiny grace note — cheerful pickup
        playTone(ac, 'triangle', 620 * rate, 930 * rate, t0, 0.07, 0.42 * vol)
        playTone(ac, 'triangle', 930 * rate, 1240 * rate, t0 + 0.05, 0.1, 0.5 * vol)
        break
      }
      case 'diamond': {
        // crystalline rising arpeggio + a glassy sparkle tail
        playTone(ac, 'sine', 880 * rate, 1320 * rate, t0, 0.09, 0.4 * vol)
        playTone(ac, 'sine', 1320 * rate, 1760 * rate, t0 + 0.05, 0.09, 0.34 * vol)
        playTone(ac, 'sine', 1760 * rate, 2349 * rate, t0 + 0.1, 0.14, 0.3 * vol)
        // shimmer dust on top
        playNoise(ac, t0 + 0.06, 0.14, 0.1 * vol, 'highpass', 4000, 7000)
        break
      }
      case 'lantern': {
        // warm soft "boop" with a gentle downward tail + a breathy puff —
        // paper-lantern coziness, like a little flame catching
        playTone(ac, 'sine', 500 * rate, 340 * rate, t0, 0.26, 0.45 * vol)
        playTone(ac, 'triangle', 250 * rate, 200 * rate, t0, 0.3, 0.16 * vol)
        playNoise(ac, t0, 0.12, 0.07 * vol, 'bandpass', 700, 1400)
        break
      }
      case 'ring': {
        // shimmery whoosh: short filtered-noise sweep + a clean rising tone
        playNoise(ac, t0, 0.2, 0.28 * vol, 'bandpass', 1100 * rate, 3400 * rate)
        playTone(ac, 'triangle', 700 * rate, 1180 * rate, t0, 0.18, 0.3 * vol)
        playTone(ac, 'sine', 1400 * rate, 1760 * rate, t0 + 0.08, 0.16, 0.16 * vol)
        break
      }
      case 'levelup': {
        // triumphant ascending major arpeggio capped by a soft sparkle
        playTone(ac, 'triangle', 523 * rate, 523 * rate, t0, 0.16, 0.4 * vol)
        playTone(ac, 'triangle', 659 * rate, 659 * rate, t0 + 0.1, 0.16, 0.4 * vol)
        playTone(ac, 'triangle', 784 * rate, 784 * rate, t0 + 0.2, 0.16, 0.4 * vol)
        playTone(ac, 'sine', 1046 * rate, 1046 * rate, t0 + 0.32, 0.4, 0.46 * vol)
        // a quiet fifth under the top note for a richer chord
        playTone(ac, 'sine', 784 * rate, 784 * rate, t0 + 0.32, 0.4, 0.22 * vol)
        playNoise(ac, t0 + 0.3, 0.3, 0.1 * vol, 'highpass', 4500, 9000)
        break
      }
      case 'boost': {
        // upward "whoomph": noise sweep + a rising body + a punchy sub thump
        playNoise(ac, t0, 0.34, 0.32 * vol, 'lowpass', 280, 2600)
        playTone(ac, 'sawtooth', 170 * rate, 540 * rate, t0, 0.32, 0.3 * vol)
        playTone(ac, 'sine', 90 * rate, 60 * rate, t0, 0.18, 0.34 * vol) // thump
        break
      }
      case 'paint': {
        // short, plucky "pop-thwip" for firing a paintball + a wet click
        playTone(ac, 'square', 440 * rate, 170 * rate, t0, 0.08, 0.32 * vol)
        playTone(ac, 'sine', 700 * rate, 300 * rate, t0, 0.05, 0.18 * vol)
        playNoise(ac, t0, 0.05, 0.18 * vol, 'highpass', 2000, 2000)
        break
      }
      case 'splash': {
        // wet noisy splat with a descending blubby tone
        playNoise(ac, t0, 0.24, 0.4 * vol, 'lowpass', 1700, 280)
        playTone(ac, 'sine', 260 * rate, 110 * rate, t0, 0.16, 0.24 * vol)
        playTone(ac, 'triangle', 180 * rate, 90 * rate, t0 + 0.03, 0.12, 0.14 * vol)
        break
      }
      case 'crash': {
        // dull thud + noise burst + a low fundamental for the impact weight
        playNoise(ac, t0, 0.32, 0.5 * vol, 'lowpass', 900, 110)
        playTone(ac, 'sine', 140 * rate, 60 * rate, t0, 0.3, 0.4 * vol)
        playTone(ac, 'triangle', 90 * rate, 50 * rate, t0, 0.22, 0.2 * vol)
        break
      }
    }
  }

  // A single pitched voice with a soft exp gain envelope + optional pitch glide.
  function playTone(
    ac: AudioContext,
    type: OscillatorType,
    fromHz: number,
    toHz: number,
    at: number,
    dur: number,
    peak: number
  ) {
    const o = ac.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(Math.max(1, fromHz), at)
    if (toHz !== fromHz)
      o.frequency.exponentialRampToValueAtTime(Math.max(1, toHz), at + dur)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, at)
    // fast-but-not-instant attack avoids the harsh click of a hard onset
    g.gain.exponentialRampToValueAtTime(
      Math.max(0.0002, peak),
      at + Math.min(0.014, dur * 0.25)
    )
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    o.connect(g)
    spawnVoice([o, g], [o], g, at + dur + 0.02)
  }

  // A filtered noise burst with an exp gain envelope and a swept cutoff.
  function playNoise(
    ac: AudioContext,
    at: number,
    dur: number,
    peak: number,
    filterType: BiquadFilterType,
    fromHz: number,
    toHz: number
  ) {
    if (!noiseBuf) return
    const src = ac.createBufferSource()
    src.buffer = noiseBuf
    src.loop = true
    const f = ac.createBiquadFilter()
    f.type = filterType
    f.frequency.setValueAtTime(Math.max(20, fromHz), at)
    if (toHz !== fromHz)
      f.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), at + dur)
    f.Q.value = 0.9
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(
      Math.max(0.0002, peak),
      at + Math.min(0.01, dur * 0.2)
    )
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    src.connect(f)
    f.connect(g)
    spawnVoice([src, f, g], [src], g, at + dur + 0.02)
  }

  // --------------------------------------------------------------------------
  // The AudioBus the rest of the game talks to.
  const bus: AudioBus = {
    play,
    setEngine,
    unlock: doUnlock,
  }

  // --------------------------------------------------------------------------
  // The GameSystem: wires the unlock listeners, then drives the engine bed.
  const system: GameSystem = {
    name: 'audio',

    init(_ctx: GameContext) {
      // Gesture listeners for autoplay unlock (passive: never blocks scrolling).
      window.addEventListener('pointerdown', onGesture, { passive: true })
      window.addEventListener('keydown', onGesture, { passive: true })
      window.addEventListener('touchstart', onGesture, { passive: true })
    },

    update(_dt: number, ctx: GameContext) {
      // Map live flight speed → [0..1] across cruise→boost. Pure number math,
      // ZERO allocation. setEngine() only ramps params; cheap on mobile.
      const sp = ctx.player.flight.speed
      const lo = TUNING.CRUISE_SPEED
      const hi = TUNING.BOOST_SPEED
      let s = (sp - lo) / (hi - lo)
      if (s < 0) s = 0
      else if (s > 1) s = 1
      // Give cruise a little baseline presence so the engine is audible at rest.
      setEngine(0.25 + 0.75 * s)
    },

    dispose() {
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('keydown', onGesture)
      window.removeEventListener('touchstart', onGesture)
      if (melodyTimer) {
        clearTimeout(melodyTimer)
        melodyTimer = null
      }
      try {
        engOscA?.stop()
        engOscB?.stop()
        subOsc?.stop()
        whirOsc?.stop()
        whirLfo?.stop()
        windSrc?.stop()
        padLfo?.stop()
        for (const o of padOscs) o.stop()
      } catch {
        /* nodes may already be stopped */
      }
      ctxA?.close().catch(() => {})
      ctxA = null
      started = false
      unlocked = false
    },
  }

  return { system, bus }
}
