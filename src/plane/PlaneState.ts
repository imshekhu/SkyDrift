import * as THREE from 'three'

// DATA, not a mesh. The renderer reads this; single-player writes it locally,
// multiplayer (later) will read remote copies and interpolate. Keeping transform
// state separate from the mesh is the load-bearing multiplayer seam.
export interface PlaneState {
  pos: THREE.Vector3
  quat: THREE.Quaternion
  vel: THREE.Vector3
  seq: number // packet sequence — enables future reconciliation
  t: number // timestamp (ms)
  flags: number // bit flags (boosting, rolling, ...)
}

export function createPlaneState(): PlaneState {
  return {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    vel: new THREE.Vector3(),
    seq: 0,
    t: 0,
    flags: 0,
  }
}
