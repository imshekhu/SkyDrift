import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { damp } from '../plane/flight'

/**
 * Sky — TinySkies-faithful atmosphere: a RADIAL multi-stop gradient sky DOME
 * driven by a 195-second day/night cycle (6 segments) that smoothly blends a
 * full SkyPreset (gradient + fog + all three scene lights + ocean tints) across
 * every transition.
 *
 * The signature look is a WIDE warm horizon BAND, so the dome is NOT a 2-color
 * lerp: each frame we (cheaply, ~4Hz) bake the blended gradient stops into a
 * 1×256 ramp texture and the dome shader samples it by view-direction HEIGHT
 * (zenith=top of ramp, horizon=bottom). The planet is a small globe, so "up" is
 * planet-relative (camera − planet centre) and the zenith stays overhead even on
 * the far hemisphere.
 *
 * Fog colour == bottom-of-ramp (horizon) colour == renderer clear colour, with a
 * near/far scaled to PLANET_RADIUS=100 + altitude so the FAR side of the planet
 * dissolves into the horizon band (the cozy enclosed feel) while near terrain
 * stays crisp.
 *
 * We OWN no lights: Lighting.ts created the one DirectionalLight (sun),
 * HemisphereLight (sky/ground bounce) and AmbientLight; we discover them via
 * scene.traverse and lerp their colour+intensity from the blended preset.
 *
 * PUBLISHED each frame at (ctx as any).sky:
 *   { preset, phaseT01, isNight, isDusk, fogColor }
 * Celestial / Weather / extras READ this to sync to the REAL cycle.
 *
 * Mobile budget: one BackSide dome (depthWrite off), one tiny ramp texture
 * rebuilt 4× a second, zero per-frame allocation (all maths reuse temporaries).
 */

// ---- A full atmosphere preset ----------------------------------------------
// skyGradient = the dome stops, zenith→horizon (pos 0 = zenith, pos 1 = horizon).
interface GradientStop { pos: number; r: number; g: number; b: number }
interface SkyPreset {
  name: string
  skyGradient: GradientStop[]
  fog: THREE.Color
  hemiSky: THREE.Color
  hemiGround: THREE.Color
  hemiInt: number
  ambient: THREE.Color
  ambientInt: number
  sun: THREE.Color // DirectionalLight tint
  sunInt: number // primary sun intensity (sun + sun2 folded — see below)
  stars: boolean
  aurora: boolean
}

// sRGB hex → linear-ish RGB triplet for shader/material colours (color-managed).
const _hexCol = new THREE.Color()
function rgb(hex: number): { r: number; g: number; b: number } {
  _hexCol.setHex(hex, THREE.SRGBColorSpace)
  return { r: _hexCol.r, g: _hexCol.g, b: _hexCol.b }
}
function stop(pos: number, hex: number): GradientStop {
  const c = rgb(hex)
  return { pos, r: c.r, g: c.g, b: c.b }
}
function col(hex: number): THREE.Color {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
}

// ===== THE THREE PRESETS (exact recipe; our art) ============================
// Light intensities: the recipe lists sun + sun2 (and fill/fill2/back). Our rig
// has ONE DirectionalLight, so we fold the dominant pair into a single intensity
// that reads the same on screen (sun is by far the strongest term). The Hemi +
// Ambient carry the fills, matching the recipe's hemi/ambient lines directly.
const DAY_PRESET: SkyPreset = {
  name: 'day',
  skyGradient: [
    stop(0.0, 0x1a4a82), stop(0.12, 0x1e5c90), stop(0.26, 0x2a8cb4),
    stop(0.4, 0x40c8dc), stop(0.52, 0x60d8e8), stop(0.62, 0x80e8f4),
    stop(0.72, 0xb8f4f0), stop(0.78, 0xe0f0d0), stop(0.84, 0xf2eca8),
    stop(0.91, 0xfff078), stop(1.0, 0xfff050),
  ],
  fog: col(0x60ccde),
  hemiSky: col(0x80ccdd), hemiGround: col(0x66aa44), hemiInt: 1.75,
  ambient: col(0xffffff), ambientInt: 1.25,
  sun: col(0xfff0d0), sunInt: 5.0,
  stars: false, aurora: false,
}

const EVENING_PRESET: SkyPreset = {
  name: 'evening',
  skyGradient: [
    stop(0.0, 0x0e0a2a), stop(0.15, 0x1a1050), stop(0.3, 0x4a2078),
    stop(0.45, 0xa03060), stop(0.55, 0xcc4840), stop(0.65, 0xe07828),
    stop(0.75, 0xf0a030), stop(0.85, 0xf8c858), stop(1.0, 0xfce0a0),
  ],
  fog: col(0xc07848),
  hemiSky: col(0xff9944), hemiGround: col(0x554422), hemiInt: 0.94,
  ambient: col(0xffd8a0), ambientInt: 0.44,
  sun: col(0xffaa40), sunInt: 3.5,
  stars: false, aurora: false,
}

const NIGHT_PRESET: SkyPreset = {
  name: 'night',
  skyGradient: [
    stop(0.0, 0x020818), stop(0.12, 0x050f22), stop(0.25, 0x08142a),
    stop(0.38, 0x0c1834), stop(0.5, 0x121a3c), stop(0.62, 0x241858),
    stop(0.74, 0x321c70), stop(0.86, 0x4428a0), stop(1.0, 0x5a34c8),
  ],
  fog: col(0x08142c),
  hemiSky: col(0x283c80), hemiGround: col(0x10202c), hemiInt: 0.625,
  ambient: col(0x7088bb), ambientInt: 0.375,
  sun: col(0x102060), sunInt: 1.25,
  stars: true, aurora: true,
}

// ===== Cycle timeline (195s, 6 segments) ====================================
// 0-60 Day · 60-75 Day→Evening · 75-105 Evening · 105-120 Evening→Night ·
// 120-180 Night · 180-195 Night→Day. Each segment names the two presets to lerp
// between and the local fraction; "hold" segments lerp a preset onto itself.
const CYCLE_SECONDS = 195
interface Segment { t0: number; t1: number; a: SkyPreset; b: SkyPreset }
const SEGMENTS: Segment[] = [
  { t0: 0, t1: 60, a: DAY_PRESET, b: DAY_PRESET }, // Day (hold)
  { t0: 60, t1: 75, a: DAY_PRESET, b: EVENING_PRESET }, // Day → Evening
  { t0: 75, t1: 105, a: EVENING_PRESET, b: EVENING_PRESET }, // Evening (hold)
  { t0: 105, t1: 120, a: EVENING_PRESET, b: NIGHT_PRESET }, // Evening → Night
  { t0: 120, t1: 180, a: NIGHT_PRESET, b: NIGHT_PRESET }, // Night (hold)
  { t0: 180, t1: 195, a: NIGHT_PRESET, b: DAY_PRESET }, // Night → Day
]

// ---- Dome / cycle constants ------------------------------------------------
const DOME_RADIUS = 1200 // < camera far plane (1400); recentred on camera each frame
const RAMP_SIZE = 256 // vertical resolution of the gradient ramp texture
const RAMP_HZ = 4 // rebuild the ramp 4× per second (cheap)
// Fog scaled to PLANET_RADIUS=100 + altitude. Per-phase the band tightens at
// dusk/night so the far hemisphere dissolves into the warm/violet horizon.
const FOG_NEAR_DAY = 70, FOG_FAR_DAY = 340
const FOG_NEAR_NIGHT = 55, FOG_FAR_NIGHT = 250

// ---- module-scoped temporaries (zero per-frame allocation) -----------------
const _camWorld = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _sunDir = new THREE.Vector3()
const _tangent = new THREE.Vector3()
const _fogCol = new THREE.Color()
const _sunCol = new THREE.Color()
const _hemiSky = new THREE.Color()
const _hemiGround = new THREE.Color()
const _ambCol = new THREE.Color()
// Cache the last clear-color hex so setClearColor is only called when it actually changes.
let _lastSkyFogHex = -1
// Reusable blended scalar out-struct (filled by sample()).
const _out = {
  preset: 'day',
  hemiInt: 1.75, ambientInt: 1.25, sunInt: 5.0,
  stars: false, aurora: false,
  isNight: false, isDusk: false,
  fogNear: FOG_NEAR_DAY, fogFar: FOG_FAR_DAY,
  // sun elevation 1=overhead(noon)→0=horizon→<0 below(night), for the disc arc.
  sunElev: 0.92,
}
// Reusable blended gradient stops (same count as the max-stop preset = 11).
const _blendStops: GradientStop[] = []
for (let i = 0; i < 11; i++) _blendStops.push({ pos: 0, r: 0, g: 0, b: 0 })

// smootherstep — buttery, banding-free transitions.
function smoother(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

export function createSkySystem(): GameSystem {
  let dome: THREE.Mesh
  let domeMat: THREE.ShaderMaterial
  let rampTex: THREE.DataTexture
  let rampData: Uint8Array
  let fog: THREE.Fog | null = null
  let rampAccum = 0 // seconds since last ramp rebuild

  // EXISTING lights discovered from the scene (we add none).
  let dirLight: THREE.DirectionalLight | null = null
  let hemiLight: THREE.HemisphereLight | null = null
  let ambLight: THREE.AmbientLight | null = null

  // Resolve which segment + local fraction the cycle clock is in.
  function segmentAt(t: number): { seg: Segment; f: number } {
    for (let i = 0; i < SEGMENTS.length; i++) {
      const s = SEGMENTS[i]
      if (t < s.t1 || i === SEGMENTS.length - 1) {
        const f = (t - s.t0) / (s.t1 - s.t0)
        return { seg: s, f: Math.min(1, Math.max(0, f)) }
      }
    }
    return { seg: SEGMENTS[0], f: 0 }
  }

  // Blend the two presets of the current segment into _out + the colour temps +
  // _blendStops, all by smootherstep(f). Both presets share the same DAY/EVENING/
  // NIGHT stop-counts within a segment? No — counts differ (11 vs 9 vs 9), so we
  // blend on the NORMALIZED gradient: sample each preset's ramp at the OTHER's
  // stop positions via a shared evaluator. We instead resample both onto a fixed
  // set of positions (preset A's positions), which is exact for holds and a clean
  // cross-fade for transitions.
  function evalGrad(g: GradientStop[], pos: number, out: { r: number; g: number; b: number }): void {
    // piecewise-linear lookup by position (stops are sorted ascending).
    if (pos <= g[0].pos) { out.r = g[0].r; out.g = g[0].g; out.b = g[0].b; return }
    const last = g[g.length - 1]
    if (pos >= last.pos) { out.r = last.r; out.g = last.g; out.b = last.b; return }
    for (let i = 1; i < g.length; i++) {
      if (pos <= g[i].pos) {
        const a = g[i - 1], b = g[i]
        const k = (pos - a.pos) / (b.pos - a.pos)
        out.r = a.r + (b.r - a.r) * k
        out.g = a.g + (b.g - a.g) * k
        out.b = a.b + (b.b - a.b) * k
        return
      }
    }
  }
  const _ga = { r: 0, g: 0, b: 0 }
  const _gb = { r: 0, g: 0, b: 0 }

  function sample(tCycle: number): typeof _out {
    const { seg, f } = segmentAt(tCycle)
    const s = smoother(f)
    const a = seg.a, b = seg.b

    // --- blended gradient stops (resample b onto a's positions) -------------
    const stops = a.skyGradient
    for (let i = 0; i < stops.length; i++) {
      const pos = stops[i].pos
      evalGrad(a.skyGradient, pos, _ga)
      evalGrad(b.skyGradient, pos, _gb)
      const o = _blendStops[i]
      o.pos = pos
      o.r = _ga.r + (_gb.r - _ga.r) * s
      o.g = _ga.g + (_gb.g - _ga.g) * s
      o.b = _ga.b + (_gb.b - _ga.b) * s
    }
    // Mark the active stop count so the ramp builder knows how many to read.
    _activeStopCount = stops.length

    // --- blended fog + lights ----------------------------------------------
    _fogCol.copy(a.fog).lerp(b.fog, s)
    _sunCol.copy(a.sun).lerp(b.sun, s)
    _hemiSky.copy(a.hemiSky).lerp(b.hemiSky, s)
    _hemiGround.copy(a.hemiGround).lerp(b.hemiGround, s)
    _ambCol.copy(a.ambient).lerp(b.ambient, s)

    _out.hemiInt = a.hemiInt + (b.hemiInt - a.hemiInt) * s
    _out.ambientInt = a.ambientInt + (b.ambientInt - a.ambientInt) * s
    _out.sunInt = a.sunInt + (b.sunInt - a.sunInt) * s

    // --- regime weights (continuous 0..1) ----------------------------------
    // How much each named regime is present in THIS blended frame. For a "hold"
    // segment one weight is 1; for a transition the weight eases with s.
    const nightW = a === NIGHT_PRESET
      ? (b === NIGHT_PRESET ? 1 : 1 - s) // Night→Day (a=Night)
      : (b === NIGHT_PRESET ? s : 0) //      Evening→Night (b=Night)
    const eveW = a === EVENING_PRESET
      ? (b === EVENING_PRESET ? 1 : 1 - s) // Evening→Night (a=Evening)
      : (b === EVENING_PRESET ? s : 0) //     Day→Evening (b=Evening)

    // --- regime flags -------------------------------------------------------
    // "preset" name = whichever side dominates this segment's blend.
    _out.preset = s < 0.5 ? a.name : b.name
    // stars/aurora ON once the frame is mostly night — extras fade them by night
    // weight, so flipping at the halfway point is the clean trigger.
    _out.stars = nightW > 0.5
    _out.aurora = nightW > 0.5
    // isNight true through the Night hold + the inner half of its transitions.
    _out.isNight = nightW >= 0.5
    // isDusk true through the Evening band + the ramps into/out of it (when not
    // already counted as night).
    _out.isDusk = eveW > 0.05 && !_out.isNight

    // --- fog near/far: tighten the band toward dusk/night ------------------
    // 0 = day band (wide), 1 = night band (cozy/tight). Evening pulls it ~half
    // way; night pulls it all the way. The far hemisphere then dissolves into
    // the warm/violet horizon colour for the enclosed TinySkies feel.
    const bandT = Math.max(nightW, eveW * 0.55)
    _out.fogNear = FOG_NEAR_DAY + (FOG_NEAR_NIGHT - FOG_NEAR_DAY) * bandT
    _out.fogFar = FOG_FAR_DAY + (FOG_FAR_NIGHT - FOG_FAR_DAY) * bandT

    // --- sun elevation arc (drives the disc; extras own the moon) ----------
    // Continuous over the full cycle: noon overhead → dips below at night.
    // phaseT01 noon≈.154 (day mid), midnight≈.769 (night mid). cos peaks at .154.
    const p01 = tCycle / CYCLE_SECONDS
    _out.sunElev = Math.cos((p01 - 0.154) * Math.PI * 2)

    return _out
  }

  // Active gradient stop-count for the current blend (set by sample()).
  let _activeStopCount = 11

  // Bake the blended _blendStops into the 1×256 RGB ramp texture (zenith at
  // texel 0 → horizon at texel RAMP_SIZE-1). Called ~4Hz.
  function buildRamp(): void {
    const n = _activeStopCount
    for (let y = 0; y < RAMP_SIZE; y++) {
      const pos = y / (RAMP_SIZE - 1) // 0=zenith → 1=horizon
      // piecewise-linear over the blended stops
      let r = _blendStops[0].r, g = _blendStops[0].g, b = _blendStops[0].b
      if (pos >= _blendStops[n - 1].pos) {
        r = _blendStops[n - 1].r; g = _blendStops[n - 1].g; b = _blendStops[n - 1].b
      } else {
        for (let i = 1; i < n; i++) {
          if (pos <= _blendStops[i].pos) {
            const sa = _blendStops[i - 1], sb = _blendStops[i]
            const k = (pos - sa.pos) / (sb.pos - sa.pos)
            r = sa.r + (sb.r - sa.r) * k
            g = sa.g + (sb.g - sa.g) * k
            b = sa.b + (sb.b - sa.b) * k
            break
          }
        }
      }
      const o = y * 4
      // store as 8-bit; shader reads it raw (already in working/linear space
      // because we authored stops via SRGBColorSpace → THREE.Color linear rgb).
      rampData[o] = Math.round(THREE.MathUtils.clamp(r, 0, 1) * 255)
      rampData[o + 1] = Math.round(THREE.MathUtils.clamp(g, 0, 1) * 255)
      rampData[o + 2] = Math.round(THREE.MathUtils.clamp(b, 0, 1) * 255)
      rampData[o + 3] = 255
    }
    rampTex.needsUpdate = true
  }

  return {
    name: 'sky',

    init(ctx: GameContext) {
      // --- Ramp texture (1×256, sampled by view height) -------------------
      rampData = new Uint8Array(RAMP_SIZE * 4)
      rampTex = new THREE.DataTexture(rampData, 1, RAMP_SIZE, THREE.RGBAFormat)
      rampTex.minFilter = THREE.LinearFilter
      rampTex.magFilter = THREE.LinearFilter
      rampTex.wrapS = THREE.ClampToEdgeWrapping
      rampTex.wrapT = THREE.ClampToEdgeWrapping
      rampTex.colorSpace = THREE.NoColorSpace // values are already working-space
      rampTex.needsUpdate = true

      // --- Sky dome -------------------------------------------------------
      // The gradient is a vertical ramp sampled by the view-direction HEIGHT
      // relative to the PLANET centre (so the zenith stays overhead on the far
      // hemisphere). h = dot(dir, up): 1 at zenith, 0 at horizon, <0 below.
      domeMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        uniforms: {
          uRamp: { value: rampTex },
          uUp: { value: new THREE.Vector3(0, 1, 0) },
          uCenter: { value: new THREE.Vector3(0, 0, 0) },
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorld = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: /* glsl */ `
          precision mediump float;
          uniform sampler2D uRamp;
          uniform vec3 uUp;
          uniform vec3 uCenter;
          varying vec3 vWorld;
          void main() {
            vec3 dir = normalize(vWorld - uCenter);
            // height: 1 = zenith, 0 = horizon. Pull a touch below the ring so
            // the warm band wraps slightly under the horizon line (no hard edge).
            float h = dot(dir, uUp);
            // map h in [-0.12 .. 1] to ramp v in [1(horizon) .. 0(zenith)].
            float v = 1.0 - clamp((h + 0.12) / 1.12, 0.0, 1.0);
            vec3 col = texture2D(uRamp, vec2(0.5, v)).rgb;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      })
      const domeGeo = new THREE.IcosahedronGeometry(DOME_RADIUS, 2)
      dome = new THREE.Mesh(domeGeo, domeMat)
      dome.frustumCulled = false
      dome.renderOrder = -10 // behind everything
      dome.matrixAutoUpdate = false
      ctx.scene.add(dome)

      // --- Fog + clear colour --------------------------------------------
      const existing = ctx.scene.fog
      if (existing && (existing as THREE.Fog).isFog) {
        fog = existing as THREE.Fog
      } else {
        fog = new THREE.Fog(DAY_PRESET.fog.getHex(), FOG_NEAR_DAY, FOG_FAR_DAY)
        ctx.scene.fog = fog
      }
      fog.color.copy(DAY_PRESET.fog)
      fog.near = FOG_NEAR_DAY
      fog.far = FOG_FAR_DAY
      ctx.renderer.setClearColor(fog.color, 1)

      // --- Discover the EXISTING lights to drive (add none) --------------
      ctx.scene.traverse((o) => {
        if (!dirLight && (o as THREE.DirectionalLight).isDirectionalLight) {
          dirLight = o as THREE.DirectionalLight
        } else if (!hemiLight && (o as THREE.HemisphereLight).isHemisphereLight) {
          hemiLight = o as THREE.HemisphereLight
        } else if (!ambLight && (o as THREE.AmbientLight).isAmbientLight) {
          ambLight = o as THREE.AmbientLight
        }
      })

      // Prime everything to the DAY phase so frame 0 already looks right.
      sample(0)
      buildRamp()
      this.update(0, ctx)
    },

    update(_dt: number, ctx: GameContext) {
      // --- advance the cycle clock ---------------------------------------
      const tCycle = ctx.elapsed() % CYCLE_SECONDS // 0..195
      const out = sample(tCycle)
      const phaseT01 = tCycle / CYCLE_SECONDS

      // --- rebuild the ramp ~4Hz (cheap) ---------------------------------
      rampAccum += _dt
      if (rampAccum >= 1 / RAMP_HZ) {
        rampAccum = 0
        buildRamp()
      }

      // --- recentre dome + planet-relative "up" --------------------------
      ctx.camera.getWorldPosition(_camWorld)
      _up.copy(_camWorld).sub(ctx.planet.mesh.position).normalize()
      if (!isFinite(_up.x) || _up.lengthSq() < 1e-6) _up.set(0, 1, 0)
      dome.position.copy(_camWorld)
      dome.updateMatrix()

      const u = domeMat.uniforms
      ;(u.uUp.value as THREE.Vector3).copy(_up)
      ;(u.uCenter.value as THREE.Vector3).copy(ctx.planet.mesh.position)

      // --- sun direction (tangent-plane arc) for the DirectionalLight ----
      _tangent.set(0, 1, 0)
      if (Math.abs(_up.dot(_tangent)) > 0.92) _tangent.set(1, 0, 0)
      _tangent.crossVectors(_up, _tangent).normalize()
      const elev = out.sunElev
      _sunDir.copy(_up).multiplyScalar(elev)
        .addScaledVector(_tangent, Math.sqrt(Math.max(0, 1 - elev * elev)))
        .normalize()

      // --- fog + clear colour (smoothed toward the blended preset) -------
      if (fog) {
        const kc = damp(2.5, _dt)
        fog.color.lerp(_fogCol, kc)
        fog.near += (out.fogNear - fog.near) * kc
        fog.far += (out.fogFar - fog.far) * kc
        // Only call setClearColor when the fog colour has meaningfully changed (saves a
        // GPU state-change per frame while the sky is stable).
        const fogHex = fog.color.getHex()
        if (fogHex !== _lastSkyFogHex) {
          _lastSkyFogHex = fogHex
          ctx.renderer.setClearColor(fog.color, 1)
        }
      }

      // --- drive the EXISTING lights -------------------------------------
      const kl = damp(2.5, _dt)
      const ks = damp(2.0, _dt)
      if (dirLight) {
        const dl = dirLight as THREE.DirectionalLight
        dl.intensity += (out.sunInt - dl.intensity) * kl
        dl.color.lerp(_sunCol, ks)
        // Light comes FROM the sun direction (dir-light position is the source).
        dl.position.copy(_sunDir).multiplyScalar(120).add(ctx.planet.mesh.position)
      }
      if (hemiLight) {
        const hl = hemiLight as THREE.HemisphereLight
        hl.intensity += (out.hemiInt - hl.intensity) * kl
        hl.color.lerp(_hemiSky, ks)
        hl.groundColor.lerp(_hemiGround, ks)
      }
      if (ambLight) {
        const al = ambLight as THREE.AmbientLight
        al.intensity += (out.ambientInt - al.intensity) * kl
        al.color.lerp(_ambCol, ks)
      }

      // --- PUBLISH the live blended atmosphere contract ------------------
      // Other systems (Celestial, Weather, sky-extras) READ this each frame.
      ;(ctx as any).sky = {
        preset: out.preset,
        phaseT01,
        isNight: out.isNight,
        isDusk: out.isDusk,
        fogColor: fog ? fog.color.getHex() : _fogCol.getHex(),
        // extras for the moon/stars/aurora builders:
        stars: out.stars,
        aurora: out.aurora,
        sunElev: out.sunElev,
        sunDir: _sunDir, // shared reference (read-only by consumers)
      }
    },

    dispose() {
      dome.geometry.dispose()
      domeMat.dispose()
      rampTex.dispose()
    },
  }
}
