import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { WORLD_SCALE } from '../world/WorldConfig'

// Underslung gatling — colorful paintballs at high cadence. Big and slow
// enough to actually SEE from the chase cam, with per-instance vivid tints
// and bloom-friendly HDR colors so they pop against sky and terrain.

const POOL = 36
const BALL_RADIUS = 1.4 // absolute world units — visible from CAM_DISTANCE=89.6
const BALL_SPEED = 60 * WORLD_SCALE // ~384 — fast but trackable; ~2× plane motion
const BALL_LIFE = 1.4
const FIRE_INTERVAL = 0.085 // gatling cadence: ~12 rounds/sec
const MUZZLE_FWD = 1.45 * WORLD_SCALE // clear of the cluster front face
const MUZZLE_DOWN = -0.55 * WORLD_SCALE // matches the gatling housing Y

// Paintball palette (HDR — values >1 so bloom catches them). One color per shot.
const PAINT = [
  new THREE.Color(2.6, 0.6, 1.8), // hot pink
  new THREE.Color(2.8, 2.2, 0.5), // sunshine yellow
  new THREE.Color(0.4, 2.6, 1.2), // mint
  new THREE.Color(0.5, 1.7, 2.8), // electric cyan
  new THREE.Color(2.8, 1.1, 0.4), // tangerine
  new THREE.Color(1.6, 0.5, 2.8), // violet
]

const _fwd = new THREE.Vector3()
const _up = new THREE.Vector3()
const _muzzle = new THREE.Vector3()
const _tmpPos = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _qIdent = new THREE.Quaternion()
const _s = new THREE.Vector3(1, 1, 1)
const PARK_Y = -1e6

export function createCannonSystem(): GameSystem {
  let im: THREE.InstancedMesh | null = null
  let geo: THREE.BufferGeometry | null = null
  let mat: THREE.Material | null = null

  const pos = new Float32Array(POOL * 3)
  const vel = new Float32Array(POOL * 3)
  const life = new Float32Array(POOL)
  const active = new Uint8Array(POOL)
  let next = 0
  let cooldown = 0

  function park(i: number) {
    active[i] = 0
    life[i] = 0
    _m.makeScale(0, 0, 0)
    _m.setPosition(0, PARK_Y - i, 0)
    im!.setMatrixAt(i, _m)
  }

  return {
    name: 'cannon',

    init(ctx: GameContext) {
      geo = new THREE.IcosahedronGeometry(BALL_RADIUS, 1) // low-poly sphere
      mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, // white base — per-instance colors multiply this
        toneMapped: false, // HDR survives the AgX tone map → bloom picks it up
      })
      im = new THREE.InstancedMesh(geo, mat, POOL)
      im.frustumCulled = false
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.renderOrder = 2
      // initialize per-instance color buffer
      for (let i = 0; i < POOL; i++) im.setColorAt(i, PAINT[0])
      if (im.instanceColor) im.instanceColor.needsUpdate = true
      ctx.scene.add(im)

      for (let i = 0; i < POOL; i++) park(i)
      im.instanceMatrix.needsUpdate = true
    },

    update(dt: number, ctx: GameContext) {
      if (!im) return

      cooldown = Math.max(0, cooldown - dt)

      if (ctx.input.firing && cooldown <= 0) {
        cooldown = FIRE_INTERVAL

        let slot = -1
        for (let s = 0; s < POOL; s++) {
          const idx = (next + s) % POOL
          if (!active[idx]) {
            slot = idx
            break
          }
        }
        if (slot < 0) {
          let minLife = Infinity
          for (let s = 0; s < POOL; s++) {
            if (life[s] < minLife) {
              minLife = life[s]
              slot = s
            }
          }
        }
        if (slot >= 0) {
          next = (slot + 1) % POOL

          const plane = ctx.player.obj
          _fwd.set(0, 0, 1).applyQuaternion(plane.quaternion)
          _up.set(0, 1, 0).applyQuaternion(plane.quaternion)

          _muzzle
            .copy(plane.position)
            .addScaledVector(_fwd, MUZZLE_FWD)
            .addScaledVector(_up, MUZZLE_DOWN)

          pos[slot * 3] = _muzzle.x
          pos[slot * 3 + 1] = _muzzle.y
          pos[slot * 3 + 2] = _muzzle.z

          vel[slot * 3] = _fwd.x * BALL_SPEED
          vel[slot * 3 + 1] = _fwd.y * BALL_SPEED
          vel[slot * 3 + 2] = _fwd.z * BALL_SPEED

          life[slot] = BALL_LIFE
          active[slot] = 1

          // random paint color per shot
          const c = PAINT[(Math.random() * PAINT.length) | 0]
          im.setColorAt(slot, c)
          if (im.instanceColor) im.instanceColor.needsUpdate = true

          ctx.audio.play('pop', { rate: 1.7 + Math.random() * 0.5 })
        }
      }

      let dirty = false
      for (let i = 0; i < POOL; i++) {
        if (!active[i]) continue
        dirty = true

        life[i] -= dt
        if (life[i] <= 0) {
          park(i)
          continue
        }

        pos[i * 3] += vel[i * 3] * dt
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt

        // spheres are rotation-symmetric — no quaternion needed.
        _m.compose(_tmpPos.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]), _qIdent, _s)
        im.setMatrixAt(i, _m)
      }

      if (dirty) im.instanceMatrix.needsUpdate = true
    },

    dispose() {
      if (im) {
        im.parent?.remove(im)
        im.dispose()
      }
      geo?.dispose()
      ;(mat as THREE.MeshBasicMaterial | null)?.dispose()
      im = null
      geo = null
      mat = null
    },
  }
}
