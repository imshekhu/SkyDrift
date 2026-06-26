import * as THREE from 'three'
import { TUNING, damp } from './flight'

// Module-scoped temps — zero per-frame allocation.
// Track last projected FOV so we only call updateProjectionMatrix when it changes.
let _lastFov = -999
const _off = new THREE.Vector3()
const _desired = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _lookAt = new THREE.Vector3()
const _radialUp = new THREE.Vector3()
const _planeUp = new THREE.Vector3()
const _up = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _qT = new THREE.Quaternion()

// Chase cam: trails behind+above, lags position (lerp) and rotation (slerp), looks
// ahead. Camera-up blends radial-up with plane-up (0.35) so the horizon never flips
// at the antipode while still inheriting the bank. Never lookAt() directly (robotic).
export function updateChaseCamera(
  cam: THREE.PerspectiveCamera,
  plane: THREE.Object3D,
  boosting: boolean,
  dt: number
) {
  _off.set(0, TUNING.CAM_HEIGHT, -TUNING.CAM_DISTANCE).applyQuaternion(plane.quaternion)
  _desired.copy(plane.position).add(_off)
  cam.position.lerp(_desired, damp(TUNING.CAM_POS_LAG, dt))

  _fwd.set(0, 0, 1).applyQuaternion(plane.quaternion)
  _lookAt.copy(plane.position).addScaledVector(_fwd, TUNING.CAM_LOOKAHEAD)

  _radialUp.copy(plane.position).normalize()
  _planeUp.set(0, 1, 0).applyQuaternion(plane.quaternion)
  _up.copy(_radialUp).lerp(_planeUp, 0.35).normalize()

  _m.lookAt(cam.position, _lookAt, _up)
  _qT.setFromRotationMatrix(_m)
  cam.quaternion.slerp(_qT, damp(TUNING.CAM_ROT_LAG, dt))

  const fov = boosting ? TUNING.CAM_FOV_BOOST : TUNING.CAM_FOV_BASE
  cam.fov += (fov - cam.fov) * damp(5, dt)
  // Only rebuild the projection matrix when the FOV meaningfully changed OR
  // when boosting (Boost.ts wraps this call to inject fovBias for the shake).
  if (boosting || Math.abs(cam.fov - _lastFov) > 0.01) {
    _lastFov = cam.fov
    cam.updateProjectionMatrix()
  }
}
