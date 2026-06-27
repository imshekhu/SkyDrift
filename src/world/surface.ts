import * as THREE from 'three'
import type { Planet } from '../core/types'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — spherical surface placement
//
// Anything that "stands on" the planet must align its model-up (local +Y) to the
// SURFACE NORMAL, not the global +Y — otherwise it leans/distorts everywhere but
// the poles. The canonical, allocation-free math is a single setFromUnitVectors()
// mapping (0,1,0) → the outward normal at the point:
//
//     obj.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), surfaceNormal)
//
// (Scenery + Landmarks already orient this way; this is the shared form so every
// building/prop uses ONE source of truth.)
// ─────────────────────────────────────────────────────────────────────────────

const UP = new THREE.Vector3(0, 1, 0)

// module-scoped temporaries — zero per-call allocation
const _nrm = new THREE.Vector3()
const _ref = new THREE.Vector3()
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _dA = new THREE.Vector3()
const _dB = new THREE.Vector3()
const _p0 = new THREE.Vector3()
const _pA = new THREE.Vector3()
const _pB = new THREE.Vector3()

/**
 * Orient `obj` so its local +Y points along the unit surface direction `dir`
 * (the radial/outward normal at that point) — i.e. it stands straight up out of
 * the ground. Exact, allocation-free. Optional `spin` yaws about the new up and
 * `lean` tilts it forward (both in radians).
 *
 *     obj.quaternion.setFromUnitVectors((0,1,0), dir)
 */
export function alignToSurface(
  obj: THREE.Object3D,
  dir: THREE.Vector3,
  spin = 0,
  lean = 0
): void {
  obj.quaternion.setFromUnitVectors(UP, _nrm.copy(dir).normalize())
  if (spin !== 0) obj.rotateY(spin) // yaw about the (now radial) local up
  if (lean !== 0) obj.rotateX(lean) // slight forward tilt for organic props
}

/**
 * Compose a surface-aligned transform into `outMatrix` (for InstancedMesh paths
 * that build matrices directly rather than transforming an Object3D). `spin` is a
 * yaw about the surface normal; `scale` is uniform. Zero-allocation (writes into
 * the caller's `outQuat`/`outMatrix`).
 */
export function surfaceMatrix(
  pos: THREE.Vector3,
  dir: THREE.Vector3,
  scale: number,
  outQuat: THREE.Quaternion,
  outScale: THREE.Vector3,
  outMatrix: THREE.Matrix4,
  spin = 0
): THREE.Matrix4 {
  outQuat.setFromUnitVectors(UP, _nrm.copy(dir).normalize())
  if (spin !== 0) {
    _ref.copy(dir) // reuse as axis
    outMatrix.makeRotationAxis(_ref.normalize(), spin) // spin about the normal
    outQuat.premultiply(_p0Quat.setFromRotationMatrix(outMatrix))
  }
  outScale.setScalar(scale)
  return outMatrix.compose(pos, outQuat, outScale)
}
const _p0Quat = new THREE.Quaternion()

/**
 * The TRUE terrain normal at a unit surface direction: the radial normal tilted
 * by the local slope (finite differences of planet.heightAt). Use this in place
 * of the bare radial `dir` when a flat-bottomed building should sit FLUSH on a
 * hillside instead of poking a corner into the slope. Writes into `out`; zero-alloc.
 */
export function terrainNormalAt(
  planet: Planet,
  dir: THREE.Vector3,
  out: THREE.Vector3
): THREE.Vector3 {
  _nrm.copy(dir).normalize()
  // two orthonormal tangents at the point (avoid degeneracy near the poles)
  const ref = Math.abs(_nrm.y) < 0.95 ? UP : _ref.set(1, 0, 0)
  _t1.crossVectors(ref, _nrm).normalize()
  _t2.crossVectors(_nrm, _t1).normalize()
  // sample the surface a small angular step along each tangent
  const eps = 0.004
  const r = planet.radius
  _dA.copy(_nrm).addScaledVector(_t1, eps).normalize()
  _dB.copy(_nrm).addScaledVector(_t2, eps).normalize()
  _p0.copy(_nrm).multiplyScalar(r + planet.heightAt(_nrm))
  _pA.copy(_dA).multiplyScalar(r + planet.heightAt(_dA)).sub(_p0)
  _pB.copy(_dB).multiplyScalar(r + planet.heightAt(_dB)).sub(_p0)
  out.crossVectors(_pA, _pB).normalize()
  if (out.dot(_nrm) < 0) out.negate() // ensure it points outward
  return out
}
