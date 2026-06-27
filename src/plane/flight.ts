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
  BOOST_THROTTLE: 0.72, // throttle above this reads as "boosting" (camera FOV + boost FX)
  SPEED_LERP: 3,

  PITCH_RATE: 1.6,
  YAW_RATE: 0.9,
  ROLL_RATE: 2.8,
  INPUT_SMOOTH: 8.0,

  BANK_TO_YAW: 1.15, // banking carves the turn (key to the arcade feel)
  AUTO_LEVEL: 0.8, // recenter wings when roll released

  MIN_ALTITUDE: 6 * S,
  MAX_ALTITUDE: 120 * S,
  CRUISE_ALTITUDE: 13 * S, // gentle target so the plane hugs the planet curvature
  ALT_RETURN: 1.4, // (legacy; superseded by the critically-damped ALT_OMEGA spring below)
  ALT_OMEGA: 2.2, // critically-damped (ζ=1) settle frequency (rad/s) — asymptotic, no overshoot
  ALT_CLIMB_RATIO: 0.5, // hold-pitch climb/dive rate as a fraction of forward speed
  ALT_PITCH_DEADZONE: 0.05, // |smoothed pitch| above this OVERRIDES the spring (free climb/dive)
  ALT_OVERRIDE_K: 6, // damp() rate easing radialVel into the override target (smooth engage)
  FLOOR_CLEARANCE: 3 * S, // HARD floor = local terrain height + this (no clipping mountains)
  CEILING_ALTITUDE: 46 * S, // HARD ceiling above base radius (can't escape to space)
  GRAVITY: 9, // (legacy/unused — altitude uses the ALT_RETURN spring)
  LIFT_AT_CRUISE: 9,
  ALIGN_RATE: 2.6, // glue to sphere — hug the curvature so it doesn't fly off tangentially
  ROLL_DURATION: 0.55,

  CAM_DISTANCE: 14 * S,
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
    // Throttle lever: W/S nudge it and it HOLDS when released (a real throttle).
    this.throttle = THREE.MathUtils.clamp(
      this.throttle + input.throttle * TUNING.THROTTLE_RATE * dt,
      0,
      1
    )
    // High throttle reads as "boosting" → camera FOV widen + the Boost FX/trail.
    this.boosting = this.throttle > TUNING.BOOST_THROTTLE
    input.boost = this.boosting // the Boost system reads this for its meter/FX

    this.orient(dt, input)
    this.roll(dt)
    this.align(dt)
    this.cruise(dt)

    _fwd.set(0, 0, 1).applyQuaternion(this.obj.quaternion)
    this.obj.position.addScaledVector(_fwd, this.speed * dt)

    this.constrainAltitude(dt)
  }

  // Banking turns, singularity-free: build a SMALL local-frame Euler delta and
  // post-multiply. (A small-angle delta is not gimbal lock — only absolute Euler is.)
  private orient(dt: number, input: InputState) {
    _right.set(1, 0, 0).applyQuaternion(this.obj.quaternion)
    _radialUp.copy(this.obj.position).normalize()
    const bank = Math.asin(THREE.MathUtils.clamp(_right.dot(_radialUp), -1, 1))
    // Banking CARVES the turn: a bank auto-induces yaw (no manual rudder anymore).
    const inducedYaw = -bank * TUNING.BANK_TO_YAW

    const dPitch = this.sc * TUNING.PITCH_RATE * dt // nose pitches up while climbing
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
  private constrainAltitude(dt: number) {
    _radialUp.copy(this.obj.position).normalize() // direction AFTER the tangential advance
    this.altitude = this.obj.position.length() - PLANET_RADIUS

    if (this.sc > TUNING.ALT_PITCH_DEADZONE) {
      // OVERRIDE — Arrow Up: the player owns altitude; the spring is suspended.
      const targetVel = this.sc * this.speed * TUNING.ALT_CLIMB_RATIO
      this.radialVel += (targetVel - this.radialVel) * damp(TUNING.ALT_OVERRIDE_K, dt)
      this.altitude += this.radialVel * dt
    } else {
      // SETTLE — exact critically-damped return to CRUISE_ALTITUDE.
      const w = TUNING.ALT_OMEGA
      const e = Math.exp(-w * dt)
      const d0 = this.altitude - TUNING.CRUISE_ALTITUDE
      const B = this.radialVel + w * d0
      this.altitude = TUNING.CRUISE_ALTITUDE + (d0 + B * dt) * e
      this.radialVel = (this.radialVel - w * B * dt) * e
      // snap the last hair to dead-still so there is literally zero residual jitter
      if (Math.abs(this.altitude - TUNING.CRUISE_ALTITUDE) < 1e-3 && Math.abs(this.radialVel) < 1e-3) {
        this.altitude = TUNING.CRUISE_ALTITUDE
        this.radialVel = 0
      }
    }

    // Re-seat at the owned altitude along the (tangentially-advanced) radial.
    this.obj.position.copy(_radialUp).multiplyScalar(PLANET_RADIUS + this.altitude)

    // --- HARD floor (follows local terrain) + HARD ceiling: cannot leave the band ---
    const ground = this.terrainHeightAt ? this.terrainHeightAt(_radialUp) : 0
    const floor = Math.max(ground + TUNING.FLOOR_CLEARANCE, TUNING.MIN_ALTITUDE)
    const ceil = TUNING.CEILING_ALTITUDE
    if (this.altitude < floor) {
      this.altitude = floor
      if (this.radialVel < 0) this.radialVel = 0
      this.obj.position.copy(_radialUp).multiplyScalar(PLANET_RADIUS + floor)
    } else if (this.altitude > ceil) {
      this.altitude = ceil
      if (this.radialVel > 0) this.radialVel = 0
      this.obj.position.copy(_radialUp).multiplyScalar(PLANET_RADIUS + ceil)
    }
  }
}
