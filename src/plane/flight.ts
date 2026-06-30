import * as THREE from 'three'
import type { InputState } from '../controls/input'
import { PLANET_RADIUS, WORLD_SCALE } from '../world/WorldConfig'

// Convention: the plane's NOSE / travel direction is local +Z. "behind" is -Z.
// PLANET_RADIUS + every length-like TUNING value derive from WorldConfig's single
// knob (× S); rates/angles are radius-invariant and stay fixed. (World plan §1.)
export { PLANET_RADIUS }

const S = WORLD_SCALE // length scale — multiply authored (radius-100) lengths by this

export const TUNING = {
  CRUISE_SPEED: 48 * S, // reference cruise speed (also Audio's engine-bed mapping range)
  BOOST_SPEED: 86 * S, // == SPEED_MAX (full throttle)
  SPEED_MIN: 26 * S, // throttle 0 → idle glide
  SPEED_MAX: 86 * S, // throttle 1 → full
  THROTTLE_RATE: 0.6, // throttle-lever units per second under full W/S
  DEFAULT_THROTTLE: 0.36, // spring-loaded rest position — speed returns here on release
  THROTTLE_RETURN: 2.0, // how fast the throttle springs back to default once W/S is let go
  BOOST_THROTTLE: 0.72, // throttle above this reads as "boosting" (camera FOV + boost FX)
  SPEED_LERP: 3,
  // Physical ground speed = this × the displayed speed. < 1 slows the plane down
  // WITHOUT changing the SPD readout (the HUD reads `speed`; only motion is scaled).
  // 2× the previous pace (~35s/lap now). Physical ground speed only — the SPD
  // readout is unchanged. (Lap time is set by this ratio, not by PLANET_RADIUS.)
  MOVE_SPEED_SCALE: 0.4148,

  PITCH_RATE: 1.6,
  YAW_RATE: 0.9,
  ROLL_RATE: 4.6, // quicker, easier banking into turns (was 2.8)
  INPUT_SMOOTH: 8.0,

  BANK_TO_YAW: 0.483, // 70% of 0.69 — reduced another 30% for gentler turns
  AUTO_LEVEL: 0.8, // recenter wings when roll released

  MIN_ALTITUDE: 6 * S,
  MAX_ALTITUDE: 120 * S,
  CRUISE_ALTITUDE: 13 * S, // gentle target so the plane hugs the planet curvature
  ALT_OMEGA: 1.8, // critically-damped (ζ=1) CLIMB-spring frequency (rad/s) — majestic, no overshoot
  TERRAIN_TRACK_K: 8, // how tightly the plane hugs the terrain CONTOUR (low-pass rate; filters bumps)
  // Altitude is TERRAIN-RELATIVE: low-passed terrain + a base clearance + the
  // climb-spring offset. Clearance runs CRUISE → CLIMB (a smooth 3× range).
  // (10/30 are authored radius-100 units; × WORLD_SCALE → terrain+64 → terrain+192 here.)
  CRUISE_CLEARANCE: 10 * S, // baseline cruise altitude (= 64 ALT on the current scale)
  CLIMB_CLEARANCE: 100, // Arrow-Up ceiling: hold Up to rise to 100 ALT
  DESCEND_CLEARANCE: 30, // S / Arrow-Down floor: hold Down to dive to 30 ALT
  CLIMB_RISE_K: 1.2, // how briskly Arrow-Up climbs toward the ceiling
  CLIMB_DESCEND_K: 1.2, // how briskly S / Arrow-Down dives toward the floor
  CLIMB_GLIDE_TIME: 10, // seconds to smoothly glide back to cruise after release
  FLOOR_CLEARANCE: 3 * S, // HARD floor = local terrain height + this (no clipping mountains)
  CEILING_ALTITUDE: 46 * S, // HARD ceiling above base radius (can't escape to space)
  GRAVITY: 9, // (legacy/unused — altitude uses the ALT_RETURN spring)
  LIFT_AT_CRUISE: 9,
  ALIGN_RATE: 4.5, // glue to sphere — eased from 7.0 so held banks aren't yanked flat (still straighter than the old 2.6)
  ROLL_DURATION: 0.55,

  CAM_DISTANCE: 18.2 * S, // 30% farther back from the plane (was 14)
  CAM_HEIGHT: 5 * S,
  CAM_POS_LAG: 6.0,
  CAM_ROT_LAG: 9.0,
  CAM_LOOKAHEAD: 10 * S,
  CAM_FOV_BASE: 62,
  CAM_FOV_BOOST: 72,
  // Aim the chase look-target below the horizon by this fraction of altitude so
  // the view shows the world below (terrain/biomes/objectives), not mostly sky —
  // important on the huge planet where cruise altitude is high. Ratio (unscaled).
  CAM_LOOK_DOWN: 0.3,
}

// dt-invariant smoothing: identical feel at 30/60/120 fps.
export const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt)

// Module-scoped temps — zero per-frame allocation (avoids iOS GC micro-stutter).
const _qDelta = new THREE.Quaternion()
const _e = new THREE.Euler()
const _right = new THREE.Vector3()
const _radialUp = new THREE.Vector3()
const _currentUp = new THREE.Vector3()
const _qAlign = new THREE.Quaternion()
const _qIdent = new THREE.Quaternion()
const _qPartial = new THREE.Quaternion()
const _qRoll = new THREE.Quaternion()
const _zAxis = new THREE.Vector3(0, 0, 1)
const _fwd = new THREE.Vector3()
const ease = (t: number) => t * t * (3 - 2 * t)

export class Flight {
  readonly obj: THREE.Object3D
  speed = TUNING.CRUISE_SPEED
  altitude = 0
  radialVel = 0
  boosting = false
  /** throttle lever 0..1 (W/S); init so the default speed ≈ CRUISE_SPEED */
  throttle = 0.36
  rolling = false
  rollProgress = 0
  /** optional: local terrain height above base radius for the hard floor; set by main */
  terrainHeightAt: ((dir: THREE.Vector3) => number) | null = null
  private sr = 0 // smoothed bank (roll) input
  private sc = 0 // smoothed climb input (Arrow Up)
  // terrain-relative altitude state:
  private smoothTerrain = NaN // low-passed terrain height we hug (snaps to terrain on frame 0)
  private climbOffset = 0 // extra clearance above cruise (0 → climbMax)
  private gliding = false // true while easing back down after an Arrow-Up release
  private glideFrom = 0 // climbOffset captured at the instant Up is released
  private glideT = 0 // 0..1 progress of the ~10s smoothstep glide-down

  constructor(obj: THREE.Object3D) {
    this.obj = obj
    obj.position.set(0, PLANET_RADIUS + TUNING.CRUISE_ALTITUDE, 0)
    // Orient so local +Z (nose) points along a surface tangent, +Y points radially out.
    const up = obj.position.clone().normalize()
    const fwd = new THREE.Vector3(1, 0, 0)
    fwd.sub(up.clone().multiplyScalar(fwd.dot(up))).normalize()
    const right = new THREE.Vector3().crossVectors(up, fwd).normalize()
    obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd))
  }

  startBarrelRoll() {
    if (!this.rolling) {
      this.rolling = true
      this.rollProgress = 0
    }
  }

  update(dt: number, input: InputState) {
    dt = Math.min(dt, 1 / 30) // clamp (resume-from-background safety)
    // Smooth the bank + climb axes (frame-rate-independent).
    this.sr += (input.roll - this.sr) * damp(TUNING.INPUT_SMOOTH, dt)
    this.sc += (input.climb - this.sc) * damp(TUNING.INPUT_SMOOTH, dt)
    // Throttle: W/S actively drive it while held (it climbs/falls), and it springs
    // BACK to the default cruise throttle the moment the key is released.
    if (input.throttle !== 0) {
      this.throttle = THREE.MathUtils.clamp(
        this.throttle + input.throttle * TUNING.THROTTLE_RATE * dt,
        0,
        1
      )
    } else {
      this.throttle += (TUNING.DEFAULT_THROTTLE - this.throttle) * damp(TUNING.THROTTLE_RETURN, dt)
    }
    // High throttle reads as "boosting" → camera FOV widen + the Boost FX/trail.
    this.boosting = this.throttle > TUNING.BOOST_THROTTLE
    input.boost = this.boosting // the Boost system reads this for its meter/FX

    this.orient(dt, input)
    this.roll(dt)
    this.align(dt)
    this.cruise(dt)

    _fwd.set(0, 0, 1).applyQuaternion(this.obj.quaternion)
    // Motion is scaled (MOVE_SPEED_SCALE) but `speed` — what the HUD shows — is not.
    this.obj.position.addScaledVector(_fwd, this.speed * TUNING.MOVE_SPEED_SCALE * dt)

    this.constrainAltitude(dt, input)
  }

  // Banking turns, singularity-free: build a SMALL local-frame Euler delta and
  // post-multiply. (A small-angle delta is not gimbal lock — only absolute Euler is.)
  private orient(dt: number, input: InputState) {
    _right.set(1, 0, 0).applyQuaternion(this.obj.quaternion)
    _radialUp.copy(this.obj.position).normalize()
    const bank = Math.asin(THREE.MathUtils.clamp(_right.dot(_radialUp), -1, 1))
    // Banking CARVES the turn: a bank auto-induces yaw (no manual rudder anymore).
    const inducedYaw = -bank * TUNING.BANK_TO_YAW

    const dPitch = -this.sc * TUNING.PITCH_RATE * dt // negative X rot = nose UP in Three.js
    const dRoll = this.sr * TUNING.ROLL_RATE * dt // A/D bank
    const dYaw = inducedYaw * dt // bank-induced only

    let levelRoll = 0
    if (Math.abs(input.roll) < 0.01 && !this.rolling) levelRoll = -bank * TUNING.AUTO_LEVEL * dt

    _e.set(dPitch, dYaw, dRoll + levelRoll, 'YXZ')
    _qDelta.setFromEuler(_e)
    this.obj.quaternion.multiply(_qDelta).normalize()
  }

  // Time-driven 360° about local +Z.
  private roll(dt: number) {
    if (!this.rolling) return
    const prev = this.rollProgress
    this.rollProgress = Math.min(1, prev + dt / TUNING.ROLL_DURATION)
    const dAngle = (ease(this.rollProgress) - ease(prev)) * Math.PI * 2
    _qRoll.setFromAxisAngle(_zAxis, dAngle)
    this.obj.quaternion.multiply(_qRoll)
    if (this.rollProgress >= 1) this.rolling = false
  }

  // Soft glue to the sphere: nudge "up" toward radial-out (slerp, never snap).
  private align(dt: number) {
    if (this.rolling) return
    _currentUp.set(0, 1, 0).applyQuaternion(this.obj.quaternion)
    _radialUp.copy(this.obj.position).normalize()
    _qAlign.setFromUnitVectors(_currentUp, _radialUp)
    _qPartial.slerpQuaternions(_qIdent, _qAlign, damp(TUNING.ALIGN_RATE, dt))
    this.obj.quaternion.premultiply(_qPartial)
  }

  private cruise(dt: number) {
    // Throttle (W/S) sets the target speed across the whole envelope; the lerp
    // gives a smooth, weighty spool-up/down rather than an instant jump.
    const target = TUNING.SPEED_MIN + (TUNING.SPEED_MAX - TUNING.SPEED_MIN) * this.throttle
    this.speed += (target - this.speed) * damp(TUNING.SPEED_LERP, dt)
  }

  // Altitude — a DECOUPLED, critically-damped spring (zero overshoot, zero jitter).
  //
  // The forward step above advanced the plane; here we OWN the radial distance, so
  // the radius is re-seated explicitly each frame: forward motion only carries us
  // ACROSS the sphere (tangentially) and contributes NO altitude — that is what
  // eliminates the curvature/align-lag drift outright (no centripetal fudge needed,
  // equilibrium == CRUISE_ALTITUDE at any speed or world size).
  //
  //   • Hold pitch  → OVERRIDE: climb(+)/dive(−) at a speed-proportional rate,
  //                   eased in so the override engages without a snap.
  //   • Release     → SETTLE: an EXACT critically-damped (ζ=1) analytic step
  //                   toward CRUISE_ALTITUDE. With d = altitude − cruise,
  //                       d(t) = (d₀ + (v₀ + ω·d₀)·t)·e^(−ω·t)
  //                   which is unconditionally stable and never overshoots at any dt.
  private constrainAltitude(dt: number, input: InputState) {
    _radialUp.copy(this.obj.position).normalize() // direction AFTER the tangential advance
    const terrain = this.terrainHeightAt ? this.terrainHeightAt(_radialUp) : 0

    // (1) TERRAIN FOLLOW — low-pass the terrain height so we hug the CONTOUR
    // smoothly (high-frequency bumps filtered, the hills tracked). This keeps the
    // baseline a clean 10 units over the ground WITHOUT jitter, even as the world
    // rushes past at speed (a single spring tracking raw terrain would lag/judder).
    if (Number.isNaN(this.smoothTerrain)) this.smoothTerrain = terrain // snap on frame 0
    this.smoothTerrain += (terrain - this.smoothTerrain) * damp(TUNING.TERRAIN_TRACK_K, dt)

    // (2) CLIMB OFFSET — Arrow-Up lifts the plane toward the ceiling; S or Arrow-Down
    // actively DESCEND back to cruise (dumping the climbed altitude); and a plain
    // release HOLDS, then glides gently back over CLIMB_GLIDE_TIME seconds with a
    // smoothstep ease (lingers high, then settles soft).
    const prevOffset = this.climbOffset
    const climbMax = TUNING.CLIMB_CLEARANCE - TUNING.CRUISE_CLEARANCE
    const descendMin = TUNING.DESCEND_CLEARANCE - TUNING.CRUISE_CLEARANCE // negative
    const climbing = input.climb > 0.5 // Arrow Up
    const descending = input.climb < -0.5 || input.throttle < -0.5 // Arrow Down or S
    if (climbing) {
      this.gliding = false
      this.climbOffset += (climbMax - this.climbOffset) * damp(TUNING.CLIMB_RISE_K, dt)
    } else if (descending) {
      // hold Down/S to actively DIVE below cruise toward the dive floor.
      this.gliding = false
      this.climbOffset += (descendMin - this.climbOffset) * damp(TUNING.CLIMB_DESCEND_K, dt)
    } else if (this.gliding || Math.abs(this.climbOffset) > 1e-3) {
      // released → linear 10s glide back toward cruise (from above OR below).
      if (!this.gliding) {
        this.gliding = true
        this.glideFrom = this.climbOffset
        this.glideT = 0
      }
      this.glideT = Math.min(1, this.glideT + dt / TUNING.CLIMB_GLIDE_TIME)
      this.climbOffset = this.glideFrom * (1 - this.glideT)
      if (this.glideT >= 1) {
        this.climbOffset = 0
        this.gliding = false
      }
    }

    // altitude = smoothed terrain + base clearance (10) + majestic climb offset (→ 30)
    this.altitude = this.smoothTerrain + TUNING.CRUISE_CLEARANCE + this.climbOffset
    this.radialVel = (this.climbOffset - prevOffset) / Math.max(dt, 1e-6) // vertical rate (HUD arrow)
    this.obj.position.copy(_radialUp).multiplyScalar(PLANET_RADIUS + this.altitude)

    // --- HARD floor against the ACTUAL terrain (never clip a sudden peak) + ceiling ---
    const floor = terrain + TUNING.FLOOR_CLEARANCE
    if (this.altitude < floor) {
      this.altitude = floor
      this.obj.position.copy(_radialUp).multiplyScalar(PLANET_RADIUS + floor)
    } else if (this.altitude > TUNING.CEILING_ALTITUDE) {
      this.altitude = TUNING.CEILING_ALTITUDE
      this.obj.position.copy(_radialUp).multiplyScalar(PLANET_RADIUS + TUNING.CEILING_ALTITUDE)
    }
  }
}
