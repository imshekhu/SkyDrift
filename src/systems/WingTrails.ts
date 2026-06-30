import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { TUNING } from '../plane/flight'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — WingTrails
//
// Two wingtip vapour ribbons that appear ONLY while the plane is banking AND
// under power. Each ribbon trails a fixed ring buffer of recent wingtip world
// positions, drawn as a tapered translucent triangle strip (wide white head →
// thin cyan tail). When activation drops, no new samples are written and the
// existing per-sample strengths decay toward 0 so the trail fades and vanishes.
//
// Zero allocation in update(): every vector/buffer is preallocated at init.
// ─────────────────────────────────────────────────────────────────────────────

// Ring-buffer length per wingtip. SEGS = SAMPLES - 1 strip quads.
const SAMPLES = 40
const SEGS = SAMPLES - 1

// Wingtip LOCAL offsets in player.obj space (mesh child scaled WORLD_SCALE*0.9).
// These are already in world-units once localToWorld'd. y=3 puts them at the
// upper wingtip; the values come straight from the plane authoring.
const TIP_LEFT = new THREE.Vector3(-15, 3, 1)
const TIP_RIGHT = new THREE.Vector3(15, 3, 1)

// Ribbon half-width taper (world units): wide at the head, hair-thin at the tail.
const WIDTH_HEAD = 1.6
const WIDTH_TAIL = 0.1

// Per-frame strength decay when inactive (≈0.90/frame at 60fps → ~0.4s fade).
const DECAY_PER_SEC = 6.0

// Activation thresholds. Trails stream while the plane banks hard AND is "under
// power" — measured from the plane's ACTUAL speed (flight.speed), not the momentary
// W/S key rate (which is 0 during steady cruise, so keying off it would make the
// ribbons flicker off mid-turn). Boosting always counts as under power.
const ROLL_MIN = 0.35
const SPEED_MIN_FRAC = 0.45 // fraction of full speed (SPEED_MAX) above which trails can form

// Head→tail vertex colors (HDR-ish white → cyan); alpha is driven separately.
const HEAD_R = 1.0, HEAD_G = 1.0, HEAD_B = 1.0
const TAIL_R = 0.35, TAIL_G = 0.9, TAIL_B = 1.0

// Module-scope temps — never allocate in update().
const _tmp = new THREE.Vector3()
const _curr = new THREE.Vector3()
const _prev = new THREE.Vector3()
const _seg = new THREE.Vector3()
const _view = new THREE.Vector3()
const _side = new THREE.Vector3()

interface Ribbon {
  /** local offset of this wingtip in player.obj space */
  tip: THREE.Vector3
  /** ring buffer of world positions (SAMPLES × 3) */
  samples: Float32Array
  /** per-sample strength 0..1 (1 = freshly written, decays to 0) */
  strength: Float32Array
  /** index of the newest sample in the ring */
  head: number
  /** how many samples have ever been written (caps at SAMPLES) */
  count: number
  geo: THREE.BufferGeometry
  posAttr: THREE.BufferAttribute
  colAttr: THREE.BufferAttribute
  mesh: THREE.Mesh
}

export function createWingTrailsSystem(): GameSystem {
  let mat: THREE.MeshBasicMaterial | null = null
  let ribbons: Ribbon[] = []

  function makeRibbon(tip: THREE.Vector3, material: THREE.Material): Ribbon {
    // SEGS quads → 2 triangles each → 6 verts/quad. Non-indexed strip so we can
    // rewrite every position in place each frame.
    const vertCount = SEGS * 6
    const positions = new Float32Array(vertCount * 3)
    const colors = new Float32Array(vertCount * 4) // RGBA (alpha = strength·taper)

    const geo = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(positions, 3)
    const colAttr = new THREE.BufferAttribute(colors, 4)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    colAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', posAttr)
    geo.setAttribute('color', colAttr)

    const mesh = new THREE.Mesh(geo, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 6 // draw over terrain/structures

    return {
      tip,
      samples: new Float32Array(SAMPLES * 3),
      strength: new Float32Array(SAMPLES),
      head: -1,
      count: 0,
      geo,
      posAttr,
      colAttr,
      mesh,
    }
  }

  // Append the current wingtip world position at the ring head with strength 1.
  function pushSample(r: Ribbon, x: number, y: number, z: number) {
    r.head = (r.head + 1) % SAMPLES
    const b = r.head * 3
    r.samples[b] = x
    r.samples[b + 1] = y
    r.samples[b + 2] = z
    r.strength[r.head] = 1
    if (r.count < SAMPLES) r.count++
  }

  // Rebuild the tapered strip geometry from the ring buffer, newest→oldest.
  function rebuild(r: Ribbon, camera: THREE.PerspectiveCamera) {
    const pos = r.posAttr.array as Float32Array
    const col = r.colAttr.array as Float32Array

    // Walk pairs of consecutive samples from the head backwards. age 0 = head.
    let vi = 0 // vertex write cursor
    const pairs = Math.min(r.count - 1, SEGS)

    for (let p = 0; p < SEGS; p++) {
      // collapse unused quads to zero-area (degenerate) so they never show.
      if (p >= pairs) {
        for (let k = 0; k < 6; k++) {
          const o = (vi + k) * 3
          pos[o] = 0; pos[o + 1] = 0; pos[o + 2] = 0
          const c = (vi + k) * 4
          col[c] = 0; col[c + 1] = 0; col[c + 2] = 0; col[c + 3] = 0
        }
        vi += 6
        continue
      }

      // sample indices: a = newer end of this segment, b = older end.
      const aAge = p
      const bAge = p + 1
      const aIdx = (r.head - aAge + SAMPLES * 2) % SAMPLES
      const bIdx = (r.head - bAge + SAMPLES * 2) % SAMPLES

      _curr.set(r.samples[aIdx * 3], r.samples[aIdx * 3 + 1], r.samples[aIdx * 3 + 2])
      _prev.set(r.samples[bIdx * 3], r.samples[bIdx * 3 + 1], r.samples[bIdx * 3 + 2])

      // segment direction
      _seg.copy(_curr).sub(_prev)
      if (_seg.lengthSq() < 1e-8) _seg.set(0, 0, 1)

      // billboard the ribbon: side = seg × (segment→camera), so the strip faces
      // the viewer regardless of plane orientation.
      _view.copy(camera.position).sub(_curr)
      _side.copy(_seg).cross(_view)
      if (_side.lengthSq() < 1e-8) _side.set(1, 0, 0)
      _side.normalize()

      // taper: width shrinks from head (age 0) to tail (age SAMPLES).
      const tA = aAge / SEGS
      const tB = bAge / SEGS
      const wA = THREE.MathUtils.lerp(WIDTH_HEAD, WIDTH_TAIL, tA)
      const wB = THREE.MathUtils.lerp(WIDTH_HEAD, WIDTH_TAIL, tB)

      // four corner positions of this quad
      const aLx = _curr.x + _side.x * wA, aLy = _curr.y + _side.y * wA, aLz = _curr.z + _side.z * wA
      const aRx = _curr.x - _side.x * wA, aRy = _curr.y - _side.y * wA, aRz = _curr.z - _side.z * wA
      const bLx = _prev.x + _side.x * wB, bLy = _prev.y + _side.y * wB, bLz = _prev.z + _side.z * wB
      const bRx = _prev.x - _side.x * wB, bRy = _prev.y - _side.y * wB, bRz = _prev.z - _side.z * wB

      // colors/alpha: lerp white→cyan by age, alpha = strength · taper-fade.
      const sA = r.strength[aIdx]
      const sB = r.strength[bIdx]
      const fadeA = 1 - tA
      const fadeB = 1 - tB
      const arc = THREE.MathUtils.lerp(HEAD_R, TAIL_R, tA)
      const agc = THREE.MathUtils.lerp(HEAD_G, TAIL_G, tA)
      const abc = THREE.MathUtils.lerp(HEAD_B, TAIL_B, tA)
      const brc = THREE.MathUtils.lerp(HEAD_R, TAIL_R, tB)
      const bgc = THREE.MathUtils.lerp(HEAD_G, TAIL_G, tB)
      const bbc = THREE.MathUtils.lerp(HEAD_B, TAIL_B, tB)
      const aAlpha = sA * fadeA
      const bAlpha = sB * fadeB

      // two triangles: (aL, aR, bL) and (aR, bR, bL)
      // tri 1
      writeVert(pos, col, vi++, aLx, aLy, aLz, arc, agc, abc, aAlpha)
      writeVert(pos, col, vi++, aRx, aRy, aRz, arc, agc, abc, aAlpha)
      writeVert(pos, col, vi++, bLx, bLy, bLz, brc, bgc, bbc, bAlpha)
      // tri 2
      writeVert(pos, col, vi++, aRx, aRy, aRz, arc, agc, abc, aAlpha)
      writeVert(pos, col, vi++, bRx, bRy, bRz, brc, bgc, bbc, bAlpha)
      writeVert(pos, col, vi++, bLx, bLy, bLz, brc, bgc, bbc, bAlpha)
    }

    r.posAttr.needsUpdate = true
    r.colAttr.needsUpdate = true
  }

  function writeVert(
    pos: Float32Array,
    col: Float32Array,
    vi: number,
    x: number, y: number, z: number,
    r: number, g: number, b: number, a: number
  ) {
    const o = vi * 3
    pos[o] = x; pos[o + 1] = y; pos[o + 2] = z
    const c = vi * 4
    col[c] = r; col[c + 1] = g; col[c + 2] = b; col[c + 3] = a
  }

  return {
    name: 'wingTrails',

    init(ctx: GameContext) {
      mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      })
      ribbons = [makeRibbon(TIP_LEFT, mat), makeRibbon(TIP_RIGHT, mat)]
      for (const r of ribbons) ctx.scene.add(r.mesh)
    },

    update(dt: number, ctx: GameContext) {
      if (!mat || ribbons.length === 0) return

      const flight = ctx.player.flight
      const underPower = ctx.player.boosting || flight.speed > TUNING.SPEED_MAX * SPEED_MIN_FRAC
      const active = Math.abs(ctx.input.roll) > ROLL_MIN && underPower
      const obj = ctx.player.obj
      const decay = Math.max(0, 1 - DECAY_PER_SEC * dt)

      for (const r of ribbons) {
        // decay every existing sample's strength toward 0
        for (let i = 0; i < SAMPLES; i++) r.strength[i] *= decay

        if (active) {
          // world position of this wingtip (localToWorld mutates _tmp)
          obj.localToWorld(_tmp.copy(r.tip))
          pushSample(r, _tmp.x, _tmp.y, _tmp.z)
        }

        rebuild(r, ctx.camera)
      }
    },

    dispose() {
      for (const r of ribbons) {
        r.mesh.parent?.remove(r.mesh)
        r.geo.dispose()
      }
      mat?.dispose()
      ribbons = []
      mat = null
    },
  }
}
