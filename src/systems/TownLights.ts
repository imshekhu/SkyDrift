import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { WORLD_SCALE } from '../world/WorldConfig'
import { FLAT_CORE_GAP } from '../world/Planet'
import { SITES, LAND_HEIGHT } from '../world/Sites'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — TownLights
//
// Warm, cozy LIGHTING for every settlement. For each SITES site with hasTown,
// anchored on the island HILLTOP (R = planet.radius − FLAT_CORE_GAP + LAND_HEIGHT
// — exactly where Placements seats its towns), we scatter three families of
// emissive, BLOOM-ing fixtures within the town footprint (local tangent plane):
//
//   • LIT WINDOWS — many small warm emissive quads at building height. One shared
//                   InstancedMesh across ALL towns (cheap; a few hundred quads).
//   • STREET LAMPS — ~6–10 short posts per town, each topped with a glowing bulb.
//                    Posts = one InstancedMesh (solid). Bulbs = one InstancedMesh
//                    (emissive, toneMapped:false) so they bloom.
//   • CAMPFIRES — 1–3 flickering warm blobs per town (emissive instanced spheres).
//
// FLICKER: bulbs + campfires oscillate their emissive brightness per frame by
// rewriting per-instance colors (HDR channels >1 so the composer's bloom catches
// them). Windows hold a steady warm glow. Heights stay < 12u. NO real THREE
// lights are added — emissive materials + the existing bloom pass only.
//
// Zero per-frame allocation: all temps are module-scope; update() only writes into
// pre-sized instanceColor buffers. Mobile-conscious (instanced, throttle-free but
// tiny per-frame work proportional to bulb+fire count, ~a few hundred max).
// ─────────────────────────────────────────────────────────────────────────────

const S = WORLD_SCALE
const UP_Y = new THREE.Vector3(0, 1, 0)

// ── module-scope scratch (NO allocation in update / per-instance loops) ────────
const _up = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _qOrient = new THREE.Quaternion() // window facing rotation in tangent plane

// Warm HDR emissive tints (channels >1 → bloom). MeshBasicMaterial + toneMapped:false.
const WINDOW_HDR = new THREE.Color(2.6, 1.7, 0.7) // warm lamp-lit pane
const BULB_HDR = new THREE.Color(2.4, 1.55, 0.6) // sodium-ish street bulb
const FIRE_HDR = new THREE.Color(3.0, 1.15, 0.32) // hot ember orange

// Per-fixture flicker bookkeeping (filled at init, read in update). Plain arrays of
// numbers/colors — no per-frame allocation.
interface Flicker {
  base: THREE.Color // baseline HDR color for this instance
  phase: number // phase offset so fixtures don't pulse in lockstep
  speed: number // oscillation rate (rad/s)
  amp: number // 0..1 fractional brightness swing
}

export function createTownLightsSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'town-lights'

  // Shared geometries (disposed once in dispose()).
  const winGeo = new THREE.PlaneGeometry(1, 1)
  const postGeo = new THREE.CylinderGeometry(0.18, 0.24, 1, 6)
  const bulbGeo = new THREE.SphereGeometry(1, 8, 6)
  const fireGeo = new THREE.IcosahedronGeometry(1, 0)

  // Shared materials.
  const winMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
    side: THREE.DoubleSide,
    vertexColors: false,
  })
  // Windows carry per-instance color (steady warm), so use instanceColor.
  const postMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHex(0x3a3540, THREE.SRGBColorSpace),
    flatShading: true,
    roughness: 0.9,
    metalness: 0,
  })
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
  const fireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })

  // Instanced meshes — counts computed after we know how many towns exist.
  let windows: THREE.InstancedMesh | null = null
  let posts: THREE.InstancedMesh | null = null
  let bulbs: THREE.InstancedMesh | null = null
  let fires: THREE.InstancedMesh | null = null

  // Flicker registries keyed to bulb / fire instance indices (parallel arrays).
  const bulbFlick: Flicker[] = []
  const fireFlick: Flicker[] = []
  // Pre-sized scratch colors written into instanceColor each frame (no alloc).
  const _c = new THREE.Color()

  let elapsed = 0

  return {
    name: 'town-lights',

    init(ctx: GameContext): void {
      const townSites = SITES.filter((s) => s.hasTown)
      const townCount = townSites.length || 1

      // ── budget the instance counts (generous but bounded) ──────────────────
      const WINDOWS_PER_TOWN = 46
      const LAMPS_MIN = 6
      const LAMPS_MAX = 10
      const FIRES_PER_TOWN = 3 // up to 3; we may use fewer, extras parked far away

      const maxWindows = townCount * WINDOWS_PER_TOWN
      const maxLamps = townCount * LAMPS_MAX
      const maxFires = townCount * FIRES_PER_TOWN

      windows = new THREE.InstancedMesh(winGeo, winMat, maxWindows)
      posts = new THREE.InstancedMesh(postGeo, postMat, maxLamps)
      bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, maxLamps)
      fires = new THREE.InstancedMesh(fireGeo, fireMat, maxFires)
      windows.name = 'town-lights.windows'
      posts.name = 'town-lights.posts'
      bulbs.name = 'town-lights.bulbs'
      fires.name = 'town-lights.fires'
      // instanceColor buffers so each pane/bulb/ember can carry its own HDR tint.
      windows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxWindows * 3), 3)
      bulbs.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxLamps * 3), 3)
      fires.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxFires * 3), 3)
      windows.frustumCulled = false
      posts.frustumCulled = false
      bulbs.frustumCulled = false
      fires.frustumCulled = false

      // Seat radius = island hilltop, identical to where Placements puts the town.
      const R = ctx.planet.radius - FLAT_CORE_GAP + LAND_HEIGHT

      let wi = 0 // window write cursor
      let li = 0 // lamp write cursor
      let fi = 0 // fire write cursor

      for (const site of townSites) {
        _up.set(site.dir[0], site.dir[1], site.dir[2]).normalize()
        // Orientation that maps local +Y → outward normal. We build each fixture's
        // world matrix from this site frame plus a local tangent offset.
        _q.setFromUnitVectors(UP_Y, _up)

        // Footprint: stay well inside the landmass (matches Placements' fit*0.6).
        const fit = site.radius * 0.6
        const ringR = Math.min(fit * 0.72, 26 * S * 0.35 + 8)

        // ── LIT WINDOWS — scatter glowing panes at building height ────────────
        // Group windows into "facades": a few panes per building-ish cluster so
        // they read as lit storeys rather than random sparks.
        const nWin = WINDOWS_PER_TOWN
        for (let k = 0; k < nWin; k++) {
          const a = ctx.rand() * Math.PI * 2
          const rr = ringR * (0.18 + ctx.rand() * 0.92)
          const lx = Math.cos(a) * rr
          const lz = Math.sin(a) * rr
          // building height band: panes sit between ~2.5 and ~7.5 units up.
          const ly = 2.5 + ctx.rand() * 5.0
          // small pane: ~0.9 wide, ~1.1 tall, faced outward-ish (random yaw).
          const w = 0.85 + ctx.rand() * 0.5
          const h = 0.95 + ctx.rand() * 0.7
          const yaw = ctx.rand() * Math.PI * 2
          composeLocal(_q, _up, R, lx, ly, lz, yaw, w, h, 1, _m)
          windows.setMatrixAt(wi, _m)
          // steady warm with slight per-pane warmth jitter (still bloom-bright).
          _c.copy(WINDOW_HDR)
          const jitter = 0.82 + ctx.rand() * 0.36
          _c.multiplyScalar(jitter)
          windows.setColorAt(wi, _c)
          wi++
        }

        // ── STREET LAMPS — short posts + glowing bulbs around the town ────────
        const nLamp = LAMPS_MIN + ((ctx.rand() * (LAMPS_MAX - LAMPS_MIN + 1)) | 0)
        const postH = 5.0 // < 12u
        for (let k = 0; k < nLamp; k++) {
          // ring them around the settlement edge, lightly jittered.
          const a = (k / nLamp) * Math.PI * 2 + ctx.rand() * 0.35
          const rr = ringR * (0.7 + ctx.rand() * 0.45)
          const lx = Math.cos(a) * rr
          const lz = Math.sin(a) * rr
          // post: a thin cylinder standing on the ground (local +Y up).
          composeLocal(_q, _up, R, lx, postH * 0.5, lz, 0, 0.6 * S * 0.0 + 1, postH, 1, _m)
          posts.setMatrixAt(li, _m)
          // bulb: a small glowing sphere atop the post.
          const bulbR = 0.55
          composeLocal(_q, _up, R, lx, postH + bulbR * 0.4, lz, 0, bulbR, bulbR, bulbR, _m)
          bulbs.setMatrixAt(li, _m)
          _c.copy(BULB_HDR)
          bulbs.setColorAt(li, _c)
          bulbFlick.push({
            base: BULB_HDR.clone(),
            phase: ctx.rand() * Math.PI * 2,
            speed: 5 + ctx.rand() * 4, // gentle electric hum flicker
            amp: 0.1 + ctx.rand() * 0.1, // subtle for street lamps
          })
          li++
        }

        // ── CAMPFIRES / braziers — 1..3 flickering embers ─────────────────────
        const nFire = 1 + ((ctx.rand() * FIRES_PER_TOWN) | 0) // 1..3
        for (let k = 0; k < FIRES_PER_TOWN; k++) {
          if (k < nFire) {
            const a = ctx.rand() * Math.PI * 2
            const rr = ringR * (0.25 + ctx.rand() * 0.5)
            const lx = Math.cos(a) * rr
            const lz = Math.sin(a) * rr
            const fr = 0.9 + ctx.rand() * 0.6
            // ember sits low to the ground (a brazier bowl height).
            composeLocal(_q, _up, R, lx, fr * 0.7 + 0.3, lz, 0, fr, fr * 1.25, fr, _m)
            fires.setMatrixAt(fi, _m)
            _c.copy(FIRE_HDR)
            fires.setColorAt(fi, _c)
            fireFlick.push({
              base: FIRE_HDR.clone(),
              phase: ctx.rand() * Math.PI * 2,
              speed: 8 + ctx.rand() * 6, // faster, livelier than lamps
              amp: 0.32 + ctx.rand() * 0.22, // big swing → dancing fire
            })
          } else {
            // unused fire slot: park it at the planet centre, invisible scale.
            _m.makeScale(0, 0, 0)
            fires.setMatrixAt(fi, _m)
            _c.setRGB(0, 0, 0)
            fires.setColorAt(fi, _c)
            fireFlick.push({ base: FIRE_HDR.clone(), phase: 0, speed: 0, amp: 0 })
          }
          fi++
        }
      }

      windows.count = wi
      posts.count = li
      bulbs.count = li
      fires.count = fi
      windows.instanceMatrix.needsUpdate = true
      posts.instanceMatrix.needsUpdate = true
      bulbs.instanceMatrix.needsUpdate = true
      fires.instanceMatrix.needsUpdate = true
      if (windows.instanceColor) windows.instanceColor.needsUpdate = true
      if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true
      if (fires.instanceColor) fires.instanceColor.needsUpdate = true

      root.add(windows, posts, bulbs, fires)
      ctx.scene.add(root)
    },

    update(dt: number, _ctx: GameContext): void {
      elapsed += dt

      // Flicker the street bulbs (subtle) — rewrite per-instance HDR brightness.
      if (bulbs && bulbs.instanceColor) {
        const n = bulbs.count
        for (let i = 0; i < n; i++) {
          const f = bulbFlick[i]
          // two interfering sines → organic, non-tiling flicker, clamped >0.
          const s =
            Math.sin(elapsed * f.speed + f.phase) * 0.6 +
            Math.sin(elapsed * f.speed * 0.47 + f.phase * 1.7) * 0.4
          const k = 1 + f.amp * s
          _c.copy(f.base).multiplyScalar(k > 0.15 ? k : 0.15)
          bulbs.setColorAt(i, _c)
        }
        bulbs.instanceColor.needsUpdate = true
      }

      // Flicker the campfires (livelier, larger swing).
      if (fires && fires.instanceColor) {
        const n = fires.count
        for (let i = 0; i < n; i++) {
          const f = fireFlick[i]
          if (f.amp === 0) continue // parked slot — leave black
          const s =
            Math.sin(elapsed * f.speed + f.phase) * 0.55 +
            Math.sin(elapsed * f.speed * 1.9 + f.phase * 0.6) * 0.3 +
            Math.sin(elapsed * f.speed * 3.3 + f.phase * 2.2) * 0.15
          const k = 1 + f.amp * s
          _c.copy(f.base).multiplyScalar(k > 0.2 ? k : 0.2)
          fires.setColorAt(i, _c)
        }
        fires.instanceColor.needsUpdate = true
      }
    },

    dispose(): void {
      root.parent?.remove(root)
      winGeo.dispose()
      postGeo.dispose()
      bulbGeo.dispose()
      fireGeo.dispose()
      winMat.dispose()
      postMat.dispose()
      bulbMat.dispose()
      fireMat.dispose()
      windows?.dispose()
      posts?.dispose()
      bulbs?.dispose()
      fires?.dispose()
      windows = null
      posts = null
      bulbs = null
      fires = null
      bulbFlick.length = 0
      fireFlick.length = 0
      root.clear()
    },
  }
}

// ── compose a fixture's world matrix from the site frame + a local tangent offset ──
// siteQ: rotation mapping local +Y → outward normal at the site centre.
// up:    the (already normalized) outward normal of the site.
// R:     seat radius (island hilltop).
// lx,ly,lz: offset in the site's LOCAL frame (x/z tangent, y outward).
// yaw:   spin about the local +Y axis (for facing windows different ways).
// sx,sy,sz: instance scale.
// Writes into `out`. Zero allocation (all temps module-scope).
function composeLocal(
  siteQ: THREE.Quaternion,
  up: THREE.Vector3,
  R: number,
  lx: number,
  ly: number,
  lz: number,
  yaw: number,
  sx: number,
  sy: number,
  sz: number,
  out: THREE.Matrix4
): void {
  // world position: site centre (up*R) + rotated local offset.
  _pos.set(lx, ly, lz).applyQuaternion(siteQ)
  _pos.x += up.x * R
  _pos.y += up.y * R
  _pos.z += up.z * R
  // orientation: site frame, then optional yaw about the local up axis.
  if (yaw !== 0) {
    _qOrient.setFromAxisAngle(UP_Y, yaw)
    _qOrient.premultiply(siteQ)
  } else {
    _qOrient.copy(siteQ)
  }
  _scl.set(sx, sy, sz)
  out.compose(_pos, _qOrient, _scl)
}
