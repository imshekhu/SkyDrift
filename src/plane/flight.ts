import * as THREE from 'three'
import type { InputState } from '../controls/input'

// Convention: the plane's NOSE / travel direction is local +Z. "behind" is -Z.
export const PLANET_RADIUS = 100

export const TUNING = {
  CRUISE_SPEED: 48,
  BOOST_SPEED: 86,
  SPEED_LERP: 3,

  PITCH_RATE: 1.6,
  YAW_RATE: 0.9,
  ROLL_RATE: 2.8,
  INPUT_SMOOTH: 8.0,

  BANK_TO_YAW: 1.15, // banking carves the turn (key to the arcade feel)
  AUTO_LEVEL: 0.8, // recenter wings when roll released

  MIN_ALTITUDE: 6,
  MAX_ALTITUDE: 120,
  CRUISE_ALTITUDE: 13, // gentle target so the plane hugs the little planet
  ALT_RETURN: 1.4, // pull toward cruise alt (player can still climb/dive)
  FLOOR_CLEARANCE: 3, // HARD floor = local terrain height + this (no clipping mountains)
  CEILING_ALTITUDE: 46, // HARD ceiling above base radius (can't escape to space)
  GRAVITY: 9,
  LIFT_AT_CRUISE: 9,
  ALIGN_RATE: 2.6, // glue to sphere — hug the curvature so it doesn't fly off tangentially
  ROLL_DURATION: 0.55,

  CAM_DISTANCE: 14,
  CAM_HEIGHT: 5,
  CAM_POS_LAG: 6.0,
  CAM_ROT_LAG: 9.0,
  CAM_LOOKAHEAD: 10,
  CAM_FOV_BASE: 62,
  CAM_FOV_BOOST: 72,
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
  rolling = false
  rollProgress = 0
  /** optional: local terrain height above base radius for the hard floor; set by main */
  terrainHeightAt: ((dir: THREE.Vector3) => number) | null = null
  private sp = 0
  private sr = 0
  private sy = 0

  constructor(obj: THREE.Object3D) {
    this.obj = obj
    obj.position.set(0, PLANET_RADIUS + 13, 0)
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
    this.sp += (input.pitch - this.sp) * damp(TUNING.INPUT_SMOOTH, dt)
    this.sr += (input.roll - this.sr) * damp(TUNING.INPUT_SMOOTH, dt)
    this.sy += (input.yaw - this.sy) * damp(TUNING.INPUT_SMOOTH, dt)
    if (input.rollMove) {
      this.startBarrelRoll()
      input.rollMove = false
    }
    this.boosting = input.boost

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
    const inducedYaw = -bank * TUNING.BANK_TO_YAW

    const dPitch = this.sp * TUNING.PITCH_RATE * dt
    const dRoll = this.sr * TUNING.ROLL_RATE * dt
    const dYaw = (this.sy * TUNING.YAW_RATE + inducedYaw) * dt

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
    const target = this.boosting ? TUNING.BOOST_SPEED : TUNING.CRUISE_SPEED
    this.speed += (target - this.speed) * damp(TUNING.SPEED_LERP, dt)
  }

  // Analytic sphere distance — gravity/lift balance keeps a neutral cruise altitude.
  private constrainAltitude(dt: number) {
    _radialUp.copy(this.obj.position).normalize()
    this.altitude = this.obj.position.length() - PLANET_RADIUS
    const a = (TUNING.CRUISE_ALTITUDE - this.altitude) * TUNING.ALT_RETURN
    this.radialVel = (this.radialVel + a * dt) * Math.exp(-1.5 * dt) // drag → no oscillation
    this.obj.position.addScaledVector(_radialUp, this.radialVel * dt)

    // --- HARD floor (follows local terrain) + HARD ceiling: the plane cannot leave this band ---
    const ground = this.terrainHeightAt ? this.terrainHeightAt(_radialUp) : 0
    const floor = Math.max(ground + TUNING.FLOOR_CLEARANCE, TUNING.MIN_ALTITUDE)
    const ceil = TUNING.CEILING_ALTITUDE
    this.altitude = this.obj.position.length() - PLANET_RADIUS
    if (this.altitude < floor) {
      this.obj.position.copy(_radialUp).multiplyScalar(PLANET_RADIUS + floor)
      if (this.radialVel < 0) this.radialVel = 0
      this.altitude = floor
    } else if (this.altitude > ceil) {
      this.obj.position.copy(_radialUp).multiplyScalar(PLANET_RADIUS + ceil)
      if (this.radialVel > 0) this.radialVel = 0
      this.altitude = ceil
    }
  }
}
