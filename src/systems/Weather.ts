import * as THREE from 'three'
import type { GameContext, GameSystem, RegionDef } from '../core/types'
import { damp, TUNING } from '../plane/flight'
import { WORLD_SCALE } from '../world/WorldConfig'

/**
 * Weather — LOCALIZED STORM ENTITIES.
 *
 * The rain VISUAL is no longer owned here: a windshield post-processing shader
 * (published by another file at `(ctx as any).rainPass`) draws the on-glass rain.
 * Weather's job is now purely SIMULATION + DRIVE:
 *
 *   (1) STORMS — a fixed pool of localized storm discs scattered over the planet
 *       surface (centred on region capitals). They spawn on a slow cadence, live
 *       for ~70-110s, and fade in/out so they never pop. Zero churn: storms are
 *       pooled and never allocate per spawn.
 *   (2) PROXIMITY → INTENSITY — each frame we take the great-circle surface
 *       distance from the player to every active storm centre, convert it to a
 *       soft-core/rim intensity, and take the MAX across storms as the player's
 *       rain intensity. It's smoothly ramped so flying into/out of a storm eases.
 *   (3) DRIVE — that intensity feeds: the windshield shader (uIntensity + uSpeed),
 *       a fog/light darken, and the sustained storm audio bed (ctx.audio.setStorm).
 *
 * Publishes (ctx as any).weather = { raining, rainIntensity01, rainbow }.
 * Reads   (ctx as any).rainPass  — the windshield ShaderPass (may be undefined early).
 *         (ctx as any).regions   — region defs (storm spawn centres).
 *         (ctx as any).sky?.{ isNight, fogColor } when present (optional contract).
 *
 * Budget: ZERO per-frame allocation (module-scoped temporaries), storms pooled.
 */

// ---- Tunables --------------------------------------------------------------
const MAX_STORMS = 3 // pooled storm slots (never allocate per spawn)
const STORM_INTERVAL = 60 // seconds between spawn attempts
const RAINBOW_SECONDS = 12
const INTENSITY_DAMP = 2.2 // damp() rate ramping rainIntensity01 toward target
const STORM_RAMP_IN = 6 // s to fade a storm in over its first moments
const STORM_RAMP_OUT = 8 // s to fade a storm out before it dies

// ---- module-scoped temporaries (no per-frame allocation) -------------------
const _fogCol = new THREE.Color()
const _darkFog = new THREE.Color()
const _playerDir = new THREE.Vector3()
const _stormPos = new THREE.Vector3()
// Cache the last fog hex so setClearColor is skipped when the colour hasn't changed.
let _lastWeatherFogHex = -1

interface Weather {
  raining: boolean
  rainIntensity01: number
  rainbow: boolean
}

/** A localized storm disc on the planet surface (pooled; never per-spawn alloc). */
interface Storm {
  active: boolean
  dir: THREE.Vector3 // unit-length surface direction of the storm centre
  radius: number // great-circle WORLD radius of the storm disc
  age: number // seconds since spawn
  life: number // total lifetime in seconds
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
/** GLSL-style smoothstep. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export function createWeatherSystem(): GameSystem {
  // Pooled storms — created ONCE in the closure; each has its own reusable dir.
  const storms: Storm[] = []
  for (let i = 0; i < MAX_STORMS; i++) {
    storms.push({
      active: false,
      dir: new THREE.Vector3(),
      radius: 0,
      age: 0,
      life: 0,
    })
  }

  // Published shared state (other systems read this off the context).
  const weather: Weather = { raining: false, rainIntensity01: 0, rainbow: false }

  // Scheduler / transition state.
  let spawnTimer = STORM_INTERVAL
  let rainbowTimer = 0
  let wasRaining = false // for the raining→clear rainbow trigger

  /** A random unit surface direction (fallback when regions are absent). */
  function randomDir(ctx: GameContext, out: THREE.Vector3): void {
    // uniform-ish on the sphere from the seeded RNG, then normalized
    out.set(
      ctx.rand() * 2 - 1,
      ctx.rand() * 2 - 1,
      ctx.rand() * 2 - 1
    )
    if (out.lengthSq() < 1e-6) out.set(0, 1, 0)
    out.normalize()
  }

  /** Activate an inactive storm slot, if one exists. */
  function trySpawn(ctx: GameContext): void {
    let storm: Storm | null = null
    for (let i = 0; i < storms.length; i++) {
      if (!storms[i].active) {
        storm = storms[i]
        break
      }
    }
    if (!storm) return // pool saturated; skip this spell

    // Spawn centre = a random region capital, else a random unit dir.
    const regions = (ctx as any).regions as
      | { defs: RegionDef[] }
      | undefined
    const defs = regions?.defs
    if (defs && defs.length > 0) {
      const r = defs[Math.floor(ctx.rand() * defs.length)]
      storm.dir.copy(r.capital).normalize()
    } else {
      randomDir(ctx, storm.dir)
    }

    storm.radius = (90 + ctx.rand() * 70) * WORLD_SCALE // great-circle WORLD radius
    storm.life = 70 + ctx.rand() * 40
    storm.age = 0
    storm.active = true
  }

  return {
    name: 'weather',

    init(ctx: GameContext) {
      // Publish the shared contract immediately so first-frame readers see it.
      weather.raining = false
      weather.rainIntensity01 = 0
      weather.rainbow = false
      ;(ctx as any).weather = weather

      spawnTimer = STORM_INTERVAL
      rainbowTimer = 0
      wasRaining = false
    },

    update(dt: number, ctx: GameContext) {
      // --- spawn cadence -------------------------------------------------
      spawnTimer -= dt
      if (spawnTimer <= 0) {
        trySpawn(ctx)
        spawnTimer = STORM_INTERVAL
      }

      // --- advance storms; deactivate the expired -----------------------
      for (let i = 0; i < storms.length; i++) {
        const s = storms[i]
        if (!s.active) continue
        s.age += dt
        if (s.age >= s.life) s.active = false
      }

      // --- proximity → target intensity (max across active storms) ------
      _playerDir.copy(ctx.player.obj.position).normalize()
      let target = 0
      for (let i = 0; i < storms.length; i++) {
        const s = storms[i]
        if (!s.active) continue
        _stormPos.copy(s.dir)
        // great-circle SURFACE distance from the storm centre to the player
        const ang = Math.acos(clamp(_playerDir.dot(_stormPos), -1, 1))
        const surfDist = ang * ctx.planet.radius
        // soft core + rim: 1 inside ~45% of the radius, smoothly 0 at the edge
        let v = 1 - smoothstep(s.radius * 0.45, s.radius, surfDist)
        // fade the storm in over its first moments and out before it dies
        const fadeIn = smoothstep(0, STORM_RAMP_IN, s.age)
        const fadeOut = smoothstep(0, STORM_RAMP_OUT, s.life - s.age)
        v *= fadeIn * fadeOut
        if (v > target) target = v
      }

      // --- smooth ramp toward target ------------------------------------
      weather.rainIntensity01 += (target - weather.rainIntensity01) * damp(INTENSITY_DAMP, dt)
      if (weather.rainIntensity01 < 0.001) weather.rainIntensity01 = 0
      const inten = weather.rainIntensity01
      const raining = inten > 0.02
      weather.raining = raining

      // --- rainbow: raining→clear during DAYTIME leaves an arc for ~12s --
      if (wasRaining && !raining) {
        const isNight = !!(ctx as any).sky?.isNight
        if (!isNight) rainbowTimer = RAINBOW_SECONDS
      }
      wasRaining = raining
      if (rainbowTimer > 0) {
        rainbowTimer -= dt
        if (rainbowTimer < 0) rainbowTimer = 0
      }
      weather.rainbow = rainbowTimer > 0

      // Republish (in case another system replaced the object reference).
      ;(ctx as any).weather = weather

      // --- drive the windshield shader (read fresh; may be undefined early)
      const rainPass = (ctx as any).rainPass
      if (rainPass) {
        rainPass.uniforms.uIntensity.value = inten
        rainPass.uniforms.uSpeed.value = clamp01(
          (ctx.player.flight.speed - TUNING.CRUISE_SPEED) /
            (TUNING.BOOST_SPEED - TUNING.CRUISE_SPEED)
        )
      }

      // --- storm audio bed ----------------------------------------------
      ctx.audio.setStorm?.(inten)

      // --- fog darken (Sky owns the colour; we only nudge it darker) ----
      // Lerps back out as inten→0 because Sky re-asserts the colour each frame.
      const sky = (ctx as any).sky
      if (inten > 0.002 && sky && typeof sky.fogColor === 'number') {
        _fogCol.setHex(sky.fogColor)
        _darkFog.copy(_fogCol).multiplyScalar(1 - 0.4 * inten)
        const f = ctx.scene.fog as THREE.Fog | null
        if (f && (f as any).isFog) {
          f.color.lerp(_darkFog, damp(3.0, dt))
          const fh = f.color.getHex()
          if (fh !== _lastWeatherFogHex) {
            _lastWeatherFogHex = fh
            ctx.renderer.setClearColor(f.color, 1)
          }
        }
      }
    },
  }
}
