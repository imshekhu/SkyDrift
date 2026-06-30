import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — DayNight
//
// THE dynamic lighting DRIVER. It creates NO lights of its own. Instead it
// DISCOVERS the single 3-light rig already built by the Lighting system
// (DirectionalLight "sun" + HemisphereLight + AmbientLight) and animates it
// through a slow, continuous, looping day↔night cycle (~180s):
//
//   • The DirectionalLight is arced around the planet so its DIRECTION sweeps
//     from horizon → overhead → horizon → under the world. Its colour and
//     intensity track the phase: warm amber + low at dawn/dusk, bright neutral
//     cream at noon, near-off deep blue at night.
//   • The HemisphereLight sky/ground colours and the AmbientLight intensity dim
//     and cool toward night, so the EMISSIVE town lamps, beacons and fireflies
//     (which bloom, toneMapped:false) POP against a dark world; by day the fill
//     is bright and the world reads cleanly lit.
//   • If scene.fog exists, its colour is nudged toward the phase tint, and the
//     renderer clear colour is eased the same way. (The Sky system, if present,
//     owns fog harder and will win — this stays a graceful no-op in that case.)
//
// We track our OWN accumulated time (not ctx.elapsed) so the cycle is smooth and
// independent of any other system's clock. The Lighting system itself adds a
// tiny per-frame "breathing" wobble to the sun; this driver sets the BASE state
// each frame on top of which that wobble rides — the two compose cozily.
//
// Robust against any light being absent (guarded null). Zero allocation in
// update() — every Vector3/Color temp is module-scoped. Mobile-conscious.
// ─────────────────────────────────────────────────────────────────────────────

// --- cycle timing ------------------------------------------------------------
const CYCLE_SECONDS = 180 // one full day↔night loop
const TWO_PI = Math.PI * 2
// Start the world a little after sunrise (mid-morning) so the opening frame is
// inviting rather than pitch black.
const PHASE_START = 0.18

// --- the sun's orbit ---------------------------------------------------------
// The DirectionalLight only cares about DIRECTION, so we park it on a large
// circle around the origin. The circle is TILTED (not a pure equatorial ring)
// so the light rakes across the globe at a pleasant angle instead of a flat
// noon-everywhere wash. Radius is comfortably inside CAMERA_FAR and well outside
// the planet — it is a *direction* source, position is only for that direction.
const SUN_ORBIT_RADIUS = 1400
// Orbit plane basis: a tilted ring. AXIS_A sweeps east↔west, AXIS_B carries the
// vertical (overhead vs under-world) component plus a slight north lean.
const _AXIS_A = new THREE.Vector3(1, 0, 0.18).normalize() // mostly +x, a hair +z
const _AXIS_B = new THREE.Vector3(-0.12, 0.96, 0.25).normalize() // mostly up, leaning n/e

// --- phase palette (authored sRGB) -------------------------------------------
// Sun colours by phase.
const SUN_DAWN = new THREE.Color().setHex(0xffb066, THREE.SRGBColorSpace) // low amber
const SUN_NOON = new THREE.Color().setHex(0xfff4dc, THREE.SRGBColorSpace) // bright cream
const SUN_NIGHT = new THREE.Color().setHex(0x24407a, THREE.SRGBColorSpace) // cold moonish blue

// Hemisphere SKY colours by phase.
const HEMI_SKY_DAY = new THREE.Color().setHex(0xbfe3f2, THREE.SRGBColorSpace) // cool day sky
const HEMI_SKY_DUSK = new THREE.Color().setHex(0xd9a17a, THREE.SRGBColorSpace) // warm dusk haze
const HEMI_SKY_NIGHT = new THREE.Color().setHex(0x16223f, THREE.SRGBColorSpace) // deep night sky

// Hemisphere GROUND bounce colours by phase.
const HEMI_GND_DAY = new THREE.Color().setHex(0xe7c9a0, THREE.SRGBColorSpace) // warm sand bounce
const HEMI_GND_DUSK = new THREE.Color().setHex(0x9a6f55, THREE.SRGBColorSpace) // dim earthy dusk
const HEMI_GND_NIGHT = new THREE.Color().setHex(0x10172b, THREE.SRGBColorSpace) // near-black floor

// Ambient floor tint by phase (kept dim; just stops pure black).
const AMB_DAY = new THREE.Color().setHex(0xfff4e6, THREE.SRGBColorSpace)
const AMB_NIGHT = new THREE.Color().setHex(0x1a2647, THREE.SRGBColorSpace)

// Fog / clear tint by phase (only applied if scene.fog already exists).
const FOG_DAY = new THREE.Color().setHex(0xbfe3f2, THREE.SRGBColorSpace)
const FOG_DUSK = new THREE.Color().setHex(0xd99a6c, THREE.SRGBColorSpace)
const FOG_NIGHT = new THREE.Color().setHex(0x0e1730, THREE.SRGBColorSpace)

// --- intensity envelopes -----------------------------------------------------
const SUN_INTENSITY_NIGHT = 0.06 // a sliver of cold moonlight
const SUN_INTENSITY_NOON = 2.25 // bright, the dominant key
const HEMI_INTENSITY_NIGHT = 0.16
const HEMI_INTENSITY_DAY = 0.82
const AMB_INTENSITY_NIGHT = 0.05
const AMB_INTENSITY_DAY = 0.16

// --- module-scoped temps (zero per-frame allocation) -------------------------
const _sunPos = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _col = new THREE.Color() // scratch colour A
const _col2 = new THREE.Color() // scratch colour B

// smoothstep helper (no alloc)
function smooth(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

/**
 * Blend three colours by a "time of day" 0..1 where 0/1 = deep night, 0.5 = noon,
 * the quarters = dawn/dusk. Writes into `out`, returns it. Zero alloc.
 *   day01      : how "daytime" we are (0 night → 1 noon), smooth.
 * We pick night→dusk→day along the rising edge symmetrically.
 */
function phaseColor(
  out: THREE.Color,
  night: THREE.Color,
  dusk: THREE.Color,
  day: THREE.Color,
  day01: number,
  dusk01: number,
): THREE.Color {
  // First fade night→day by day01, then push toward the warm dusk colour by how
  // "edge of day" we are (dusk01 peaks at the dawn/dusk terminators).
  out.copy(night).lerp(day, day01)
  out.lerp(dusk, dusk01)
  return out
}

export function createDayNightSystem(): GameSystem {
  // Discovered rig (filled in init via traverse). Any may stay null.
  let sun: THREE.DirectionalLight | null = null
  let hemi: THREE.HemisphereLight | null = null
  let ambient: THREE.AmbientLight | null = null

  // Our own accumulated cycle time, independent of other clocks.
  let t = PHASE_START * CYCLE_SECONDS

  // Eased clear/fog colour state so renderer.setClearColor doesn't pop.
  const _clear = new THREE.Color().copy(FOG_DAY)
  let clearInit = false

  function discover(scene: THREE.Scene) {
    scene.traverse((o) => {
      // Use the typed flags Three sets on each light class; avoid instanceof so a
      // duplicated three module never breaks discovery.
      const any = o as unknown as {
        isDirectionalLight?: boolean
        isHemisphereLight?: boolean
        isAmbientLight?: boolean
      }
      if (!sun && any.isDirectionalLight) sun = o as THREE.DirectionalLight
      else if (!hemi && any.isHemisphereLight) hemi = o as THREE.HemisphereLight
      else if (!ambient && any.isAmbientLight) ambient = o as THREE.AmbientLight
    })
  }

  return {
    name: 'daynight',

    init(ctx: GameContext) {
      discover(ctx.scene)
      // If the Lighting system hasn't been added yet, retry happens lazily in
      // update() (cheap: bail out of the traverse once all three are found).
      // Prime frame 0 so there's no pop.
      this.update(0, ctx)
    },

    update(dt: number, ctx: GameContext) {
      // Lazy (re)discovery until the whole rig is present. Once all found, skip.
      if (!sun || !hemi || !ambient) discover(ctx.scene)

      // --- advance our own looping clock -----------------------------------
      t += dt
      if (t >= CYCLE_SECONDS) t -= CYCLE_SECONDS * Math.floor(t / CYCLE_SECONDS)
      const phase = t / CYCLE_SECONDS // 0..1 around the cycle
      const ang = phase * TWO_PI // 0 = sunrise-ish

      // Height of the sun above the horizon, -1..1 (sin of orbit angle). We
      // offset so phase 0 sits at the horizon climbing up.
      const elevation = Math.sin(ang) // +1 noon, 0 horizons, -1 deep night
      // day01: 0 at/below horizon → 1 at noon. smooth for a soft dawn ramp.
      const day01 = smooth((elevation + 0.12) / 1.12)
      // dusk01: peaks right at the terminators (sun near the horizon), 0 at noon
      // and 0 deep at night. A warm rim of golden hour.
      const horizonNear = 1 - Math.min(1, Math.abs(elevation) / 0.32)
      const dusk01 = smooth(horizonNear) * smooth(elevation * 4 + 1) // only on the lit side-ish

      // --- arc the directional light around the tilted orbit ---------------
      if (sun) {
        const s = sun as THREE.DirectionalLight
        _a.copy(_AXIS_A).multiplyScalar(Math.cos(ang) * SUN_ORBIT_RADIUS)
        _b.copy(_AXIS_B).multiplyScalar(Math.sin(ang) * SUN_ORBIT_RADIUS)
        _sunPos.copy(_a).add(_b)
        s.position.copy(_sunPos)
        if (s.target) s.target.position.set(0, 0, 0)

        // colour: night → noon, then warmed toward amber near the horizon.
        phaseColor(_col, SUN_NIGHT, SUN_DAWN, SUN_NOON, day01, dusk01 * 0.9)
        s.color.copy(_col)

        // intensity: cold sliver at night, full key at noon.
        s.intensity = THREE.MathUtils.lerp(SUN_INTENSITY_NIGHT, SUN_INTENSITY_NOON, day01)
      }

      // --- hemisphere fill: dim + cool at night so emissives POP -----------
      if (hemi) {
        const h = hemi as THREE.HemisphereLight
        phaseColor(_col, HEMI_SKY_NIGHT, HEMI_SKY_DUSK, HEMI_SKY_DAY, day01, dusk01 * 0.7)
        h.color.copy(_col) // .color === sky colour
        phaseColor(_col2, HEMI_GND_NIGHT, HEMI_GND_DUSK, HEMI_GND_DAY, day01, dusk01 * 0.5)
        h.groundColor.copy(_col2)
        h.intensity = THREE.MathUtils.lerp(HEMI_INTENSITY_NIGHT, HEMI_INTENSITY_DAY, day01)
      }

      // --- ambient floor: barely-there at night ----------------------------
      if (ambient) {
        const a = ambient as THREE.AmbientLight
        _col.copy(AMB_NIGHT).lerp(AMB_DAY, day01)
        a.color.copy(_col)
        a.intensity = THREE.MathUtils.lerp(AMB_INTENSITY_NIGHT, AMB_INTENSITY_DAY, day01)
      }

      // --- fog + clear tint (graceful; Sky system, if present, wins) --------
      // Only touch fog if it exists; otherwise nudging the clear colour alone
      // would fight a sky dome, so we leave it be when there's no fog.
      const fog = ctx.scene.fog
      if (fog) {
        phaseColor(_col, FOG_NIGHT, FOG_DUSK, FOG_DAY, day01, dusk01 * 0.8)
        const k = 1 - Math.exp(-3 * dt) // exp smoothing toward target
        fog.color.lerp(_col, k)
        if (!clearInit) {
          _clear.copy(fog.color)
          clearInit = true
        }
        _clear.lerp(fog.color, k)
        ctx.renderer.setClearColor(_clear, 1)
      }
    },

    dispose() {
      // We created nothing in the scene — just drop our references so the GC can
      // reclaim them and a re-init starts clean.
      sun = null
      hemi = null
      ambient = null
    },
  }
}
