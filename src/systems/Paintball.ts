import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'

/**
 * Paintball — the playful PvP / target weapon, juiced.
 *
 * Press **F** (or pointer-down on the canvas, or emit the shared `fire` event)
 * to launch a pooled paintball out the plane's nose (local +Z). Firing pops a
 * bright additive MUZZLE FLASH and a little kick of recoil-feel; each ball flies
 * a gravity-less arc trailing a glowing additive comet tail and spinning faintly.
 * Along the way it squared-distance tests against optional NPC targets at
 * `(ctx as any).npcTargets`; a hit pops a paint SPLAT decal + a burst RING, plays
 * SFX, floats a "+score" POPUP, and bumps `(ctx as any).score`. Balls also splat
 * when they reach the planet surface, so shots always read.
 *
 * Fire cadence scales with `(ctx as any).upgrades.fireMult` (Progression's
 * `fire` upgrade card), clamped so it can never machine-gun the GC to death.
 *
 * Perf (mobile-first, ≤3 real lights respected — everything here is self-lit):
 *   - ONE pooled InstancedMesh for all ball heads          (BALL_POOL instances)
 *   - ONE pooled additive Points cloud for trails (BALL_POOL * TRAIL_LEN points)
 *   - ONE pooled InstancedMesh for paint splat decals      (SPLAT_POOL instances)
 *   - ONE pooled InstancedMesh for hit burst rings         (RING_POOL instances)
 *   - ONE pooled additive Sprite per muzzle flash          (FLASH_POOL sprites)
 *   - ONE pooled canvas-sprite per score popup             (POPUP_POOL sprites)
 *   - SoA Float32 state buffers, round-robin pools, squared-distance hit tests,
 *     module-scoped temps → ZERO per-frame allocation in update().
 *
 * NPC target duck-type (all fields optional except `position`; the system fully
 * tolerates the array being absent):
 *   interface NpcTarget {
 *     position: THREE.Vector3       // world position (required for a hit test)
 *     radius?: number               // hit radius; default NPC_HIT_RADIUS
 *     alive?: boolean               // skipped when explicitly false
 *     onHit?: (info?: any) => void  // called { pos, color } on impact
 *   }
 */

// ----- tuning ---------------------------------------------------------------

const BALL_POOL = 40 // simultaneous paintballs in flight
const TRAIL_LEN = 7 // trail points trailing each ball
const SPLAT_POOL = 18 // simultaneous paint decals
const RING_POOL = 12 // simultaneous hit-burst rings
const FLASH_POOL = 8 // simultaneous muzzle flashes
const POPUP_POOL = 8 // simultaneous floating score popups

const BALL_SPEED = 150 // world units/s — fast, snappy, reads instantly
const BALL_LIFETIME = 1.6 // seconds before a ball auto-parks
const BALL_RADIUS = 0.42 // visual head radius
const MUZZLE_FORWARD = 2.6 // spawn this far ahead of the plane origin (past nose)
const BALL_SPREAD = 0.018 // tiny per-shot dir jitter (radians-ish) for snap
const BALL_POP_T = 0.08 // seconds a fresh ball scales up from a dot
const BALL_SPIN = 7.0 // rad/s visual head spin

const BASE_COOLDOWN = 0.28 // seconds between shots at fireMult = 1
const MIN_COOLDOWN = 0.06 // hard floor so upgrades can't fire every frame

const NPC_HIT_RADIUS = 3.2 // default target hit radius when a target omits one
const GROUND_SKIN = 0.5 // splat when a ball is within this of the surface
const SPLAT_LIFETIME = 2.2 // seconds a paint decal lingers before vanishing
const SPLAT_SIZE = 3.4 // decal diameter (world units)
const SCORE_PER_HIT = 25 // points added to (ctx as any).score on a target hit

const RING_LIFETIME = 0.42 // seconds a hit-burst ring expands + fades
const RING_MAX = 6.5 // ring world diameter at full expansion

const FLASH_LIFETIME = 0.12 // seconds a muzzle flash lives
const FLASH_SIZE = 4.4 // muzzle flash sprite size at birth

const POPUP_LIFETIME = 0.9 // seconds a score popup floats + fades
const POPUP_RISE = 5.0 // world units a popup drifts outward (radially) over its life
const POPUP_SIZE = 4.6 // popup sprite world size

const TRAIL_SPACING = 0.022 // seconds between trail samples
const TRAIL_POINT_LIFE = TRAIL_LEN * TRAIL_SPACING // a trail point's lifespan

const PARK_Y = -100000 // far below the world: where dead instances/points hide

// Cheerful pastel paint palette (authored sRGB, color-managed exactly like PAL).
// Coral is reserved for the plane, so paint stays cool/bright for clarity.
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const PAINT_COLORS: readonly THREE.Color[] = [
  PAL.gem, // gem cyan
  PAL.planeWing, // sunny yellow
  srgb(0xb6f5a0), // mint green
  srgb(0xc8a8ff), // soft violet
  srgb(0xffa9d4), // bubblegum pink
]

// ----- module-scoped temps (ZERO per-frame allocation) ----------------------

const _muzzle = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _side = new THREE.Vector3()
const _ballPos = new THREE.Vector3()
const _toTarget = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _quatIdent = new THREE.Quaternion()
const _spinQuat = new THREE.Quaternion()
const _mat4 = new THREE.Matrix4()
const _col = new THREE.Color()
const _normal = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _splatQuat = new THREE.Quaternion()
const _park = new THREE.Vector3()
const _spinAxis = new THREE.Vector3()
const WHITE = new THREE.Color(1, 1, 1) // reused for tint-lerps (no per-frame alloc)

export function createPaintballSystem(): GameSystem {
  const group = new THREE.Group()
  group.name = 'paintball'

  // Disposables.
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  const textures: THREE.Texture[] = []

  // --- ball heads: one InstancedMesh of low-poly self-lit spheres ---
  let ballMesh: THREE.InstancedMesh | null = null
  const bPos = new Float32Array(BALL_POOL * 3) // world position
  const bVel = new Float32Array(BALL_POOL * 3) // constant velocity (no gravity)
  const bLife = new Float32Array(BALL_POOL) // remaining seconds; 0 = dead
  const bColor = new Uint8Array(BALL_POOL) // index into PAINT_COLORS
  const bTrailT = new Float32Array(BALL_POOL) // time since last trail sample
  const bTrailHead = new Uint8Array(BALL_POOL) // ring write index into this ball's trail
  const bSpin = new Float32Array(BALL_POOL) // accumulated visual spin angle
  let nextBall = 0 // round-robin spawn slot

  // --- trails: one additive vertex-colored Points cloud ---
  let trailGeo: THREE.BufferGeometry | null = null
  const TOTAL_TRAIL = BALL_POOL * TRAIL_LEN
  const tPos = new Float32Array(TOTAL_TRAIL * 3)
  const tCol = new Float32Array(TOTAL_TRAIL * 3)
  const tLife = new Float32Array(TOTAL_TRAIL) // remaining seconds; 0 = dead

  // --- splat decals: one InstancedMesh of flat self-lit disks ---
  let splatMesh: THREE.InstancedMesh | null = null
  const sLife = new Float32Array(SPLAT_POOL) // remaining seconds; 0 = dead
  const sPos = new Float32Array(SPLAT_POOL * 3) // impact position (re-composed each frame)
  const sQuat = new Float32Array(SPLAT_POOL * 4) // surface-aligned rotation (xyzw)
  const sSpin = new Float32Array(SPLAT_POOL) // per-splat z-roll for variety
  let nextSplat = 0

  // --- hit burst rings: one InstancedMesh of flat annulus disks ---
  let ringMesh: THREE.InstancedMesh | null = null
  let ringMat: THREE.MeshBasicMaterial | null = null
  const rLife = new Float32Array(RING_POOL) // remaining seconds; 0 = dead
  const rPos = new Float32Array(RING_POOL * 3)
  const rQuat = new Float32Array(RING_POOL * 4)
  let nextRing = 0

  // --- muzzle flashes: pooled additive sprites ---
  const flashes: THREE.Sprite[] = []
  const fLife = new Float32Array(FLASH_POOL)
  let nextFlash = 0

  // --- score popups: pooled canvas sprites ("+25") ---
  const popups: THREE.Sprite[] = []
  const pLife = new Float32Array(POPUP_POOL)
  const pPos = new Float32Array(POPUP_POOL * 3) // anchor (impact) position
  const pDir = new Float32Array(POPUP_POOL * 3) // radial-out drift direction
  let nextPopup = 0

  // --- fire intent (edge-triggered, debounced by the cooldown) ---
  let firePressed = false
  let cooldown = 0
  let offFire: (() => void) | null = null
  let onKeyDown: ((e: KeyboardEvent) => void) | null = null
  let onPointerDown: (() => void) | null = null
  let domEl: HTMLElement | null = null // captured for clean listener removal

  let PLANET_RADIUS = 100

  // ---- park a pooled instance slot far below the world ----
  function park(slot: number): THREE.Vector3 {
    _park.set(0, PARK_Y - slot, 0)
    return _park
  }

  // ---- a soft round additive glow texture (muzzle flash / popup bg use) ----
  function makeGlowTexture(): THREE.Texture {
    const size = 64
    const cnv = document.createElement('canvas')
    cnv.width = cnv.height = size
    const g = cnv.getContext('2d')!
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grd.addColorStop(0.0, 'rgba(255,255,255,1)')
    grd.addColorStop(0.35, 'rgba(255,255,255,0.7)')
    grd.addColorStop(1.0, 'rgba(255,255,255,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(cnv)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  // ---- a crisp "+25" label texture for score popups ----
  function makeScoreTexture(): THREE.Texture {
    const w = 128
    const h = 64
    const cnv = document.createElement('canvas')
    cnv.width = w
    cnv.height = h
    const g = cnv.getContext('2d')!
    g.clearRect(0, 0, w, h)
    g.font = 'bold 40px system-ui, -apple-system, Segoe UI, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const label = '+' + SCORE_PER_HIT
    // soft dark outline for legibility against bright sky/planet
    g.lineWidth = 6
    g.strokeStyle = 'rgba(40,40,60,0.55)'
    g.strokeText(label, w / 2, h / 2 + 2)
    g.fillStyle = '#ffffff'
    g.fillText(label, w / 2, h / 2 + 2)
    const tex = new THREE.CanvasTexture(cnv)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  // ---- spawn one paintball from the plane's nose (with muzzle pop + spread) ----
  function spawnBall(ctx: GameContext): void {
    const slot = nextBall
    nextBall = (nextBall + 1) % BALL_POOL

    const player = ctx.player.obj
    _fwd.set(0, 0, 1).applyQuaternion(player.quaternion).normalize() // nose = local +Z
    _muzzle.copy(player.position).addScaledVector(_fwd, MUZZLE_FORWARD)

    // tiny cone spread for snap (uses plane's local X as the lateral axis)
    _side.set(1, 0, 0).applyQuaternion(player.quaternion)
    const jx = (ctx.rand() - 0.5) * 2 * BALL_SPREAD
    const jy = (ctx.rand() - 0.5) * 2 * BALL_SPREAD
    _fwd.addScaledVector(_side, jx)
    _fwd.y += jy
    _fwd.normalize()

    const b = slot * 3
    bPos[b] = _muzzle.x
    bPos[b + 1] = _muzzle.y
    bPos[b + 2] = _muzzle.z
    bVel[b] = _fwd.x * BALL_SPEED
    bVel[b + 1] = _fwd.y * BALL_SPEED
    bVel[b + 2] = _fwd.z * BALL_SPEED
    bLife[slot] = BALL_LIFETIME
    bTrailT[slot] = 0
    bTrailHead[slot] = 0
    bSpin[slot] = 0
    bColor[slot] = Math.floor(ctx.rand() * PAINT_COLORS.length) % PAINT_COLORS.length

    // Clear this ball's trail ring so a recycled slot shows no stale streak.
    const tBase = slot * TRAIL_LEN
    for (let i = 0; i < TRAIL_LEN; i++) tLife[tBase + i] = 0

    spawnFlash(_muzzle, bColor[slot]!)
    ctx.audio.play('fire', { volume: 0.72, rate: 0.95 + ctx.rand() * 0.1 })
    ctx.events.emit('fire', { origin: _muzzle, dir: _fwd })
  }

  // ---- write one trail point at a ball's current position ----
  function sampleTrail(slot: number): void {
    const head = bTrailHead[slot]!
    const idx = slot * TRAIL_LEN + head
    const b = slot * 3
    const p = idx * 3
    tPos[p] = bPos[b]!
    tPos[p + 1] = bPos[b + 1]!
    tPos[p + 2] = bPos[b + 2]!
    const col = PAINT_COLORS[bColor[slot]!]!
    tCol[p] = col.r
    tCol[p + 1] = col.g
    tCol[p + 2] = col.b
    tLife[idx] = TRAIL_POINT_LIFE
    bTrailHead[slot] = (head + 1) % TRAIL_LEN
  }

  // ---- pop a muzzle flash at a world position (additive sprite, bright) ----
  function spawnFlash(at: THREE.Vector3, colorIdx: number): void {
    const slot = nextFlash
    nextFlash = (nextFlash + 1) % FLASH_POOL
    const spr = flashes[slot]
    if (!spr) return
    fLife[slot] = FLASH_LIFETIME
    spr.position.copy(at)
    // white-hot core tinted toward the paint color so each shot has a flavor
    _col.copy(PAINT_COLORS[colorIdx]!).lerp(WHITE, 0.6)
    spr.material.color.copy(_col)
    spr.material.opacity = 1
    spr.scale.setScalar(FLASH_SIZE)
    spr.visible = true
  }

  // ---- pop a paint splat decal at a world position, tinted by paint index ----
  function spawnSplat(at: THREE.Vector3, colorIdx: number, rand: number): void {
    if (!splatMesh) return
    const slot = nextSplat
    nextSplat = (nextSplat + 1) % SPLAT_POOL
    sLife[slot] = SPLAT_LIFETIME
    sSpin[slot] = rand * Math.PI * 2

    // Lay the disk flat against the planet: its face normal (+Y, baked into the
    // geometry) aligns to the radial-out direction at the impact point. Store
    // position + rotation so update() can re-compose (shrink) without GPU readback.
    _normal.copy(at)
    if (_normal.lengthSq() < 1e-6) _normal.copy(_up)
    else _normal.normalize()
    _splatQuat.setFromUnitVectors(_up, _normal)

    const q = slot * 4
    sQuat[q] = _splatQuat.x
    sQuat[q + 1] = _splatQuat.y
    sQuat[q + 2] = _splatQuat.z
    sQuat[q + 3] = _splatQuat.w
    const v = slot * 3
    sPos[v] = at.x
    sPos[v + 1] = at.y
    sPos[v + 2] = at.z

    _col.copy(PAINT_COLORS[colorIdx]!)
    splatMesh.setColorAt(slot, _col)
    if (splatMesh.instanceColor) splatMesh.instanceColor.needsUpdate = true
    seatSplat(slot) // seat immediately so it never flickers at the origin
  }

  // ---- pop an expanding hit-burst ring at a world position ----
  function spawnRing(at: THREE.Vector3, colorIdx: number): void {
    if (!ringMesh) return
    const slot = nextRing
    nextRing = (nextRing + 1) % RING_POOL
    rLife[slot] = RING_LIFETIME

    _normal.copy(at)
    if (_normal.lengthSq() < 1e-6) _normal.copy(_up)
    else _normal.normalize()
    _splatQuat.setFromUnitVectors(_up, _normal)
    const q = slot * 4
    rQuat[q] = _splatQuat.x
    rQuat[q + 1] = _splatQuat.y
    rQuat[q + 2] = _splatQuat.z
    rQuat[q + 3] = _splatQuat.w
    const v = slot * 3
    rPos[v] = at.x
    rPos[v + 1] = at.y
    rPos[v + 2] = at.z

    _col.copy(PAINT_COLORS[colorIdx]!).lerp(WHITE, 0.35)
    ringMesh.setColorAt(slot, _col)
    if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true
    seatRing(slot)
  }

  // ---- pop a floating "+score" popup, drifting radially outward ----
  function spawnPopup(at: THREE.Vector3): void {
    const slot = nextPopup
    nextPopup = (nextPopup + 1) % POPUP_POOL
    const spr = popups[slot]
    if (!spr) return
    pLife[slot] = POPUP_LIFETIME
    const v = slot * 3
    pPos[v] = at.x
    pPos[v + 1] = at.y
    pPos[v + 2] = at.z
    _normal.copy(at)
    if (_normal.lengthSq() < 1e-6) _normal.copy(_up)
    else _normal.normalize()
    pDir[v] = _normal.x
    pDir[v + 1] = _normal.y
    pDir[v + 2] = _normal.z
    spr.position.copy(at)
    spr.material.opacity = 1
    spr.scale.setScalar(POPUP_SIZE)
    spr.visible = true
  }

  // ---- write a splat instance's transform from its remaining life (pop/shrink) ----
  function seatSplat(slot: number): void {
    if (!splatMesh) return
    const life = sLife[slot]!
    if (life <= 0) {
      _scale.setScalar(0.0001)
      _mat4.compose(park(slot), _quatIdent, _scale)
      splatMesh.setMatrixAt(slot, _mat4)
      return
    }
    const k = life / SPLAT_LIFETIME // 1 → 0
    // overshoot pop-in for splat (lands a touch larger, settles)
    let grow: number
    if (k > 0.85) {
      const t = (1 - k) / 0.15 // 0 → 1
      grow = t * (1.18 - 0.18 * t) // ease toward ~1.0 with a hair of overshoot
    } else {
      grow = 1
    }
    const fade = k < 0.33 ? k / 0.33 : 1 // shrink out near death
    const s = SPLAT_SIZE * Math.min(grow, fade)
    const v = slot * 3
    const q = slot * 4
    _park.set(sPos[v]!, sPos[v + 1]!, sPos[v + 2]!)
    _splatQuat.set(sQuat[q]!, sQuat[q + 1]!, sQuat[q + 2]!, sQuat[q + 3]!)
    // roll the disk in-plane (about its normal) for varied splat shapes
    _spinQuat.setFromAxisAngle(_up, sSpin[slot]!)
    _splatQuat.multiply(_spinQuat)
    _scale.setScalar(Math.max(0.0001, s))
    _mat4.compose(_park, _splatQuat, _scale)
    splatMesh.setMatrixAt(slot, _mat4)
  }

  // ---- write a ring instance's transform from its remaining life (expand/fade) ----
  function seatRing(slot: number): void {
    if (!ringMesh) return
    const life = rLife[slot]!
    if (life <= 0) {
      _scale.setScalar(0.0001)
      _mat4.compose(park(slot), _quatIdent, _scale)
      ringMesh.setMatrixAt(slot, _mat4)
      return
    }
    const k = 1 - life / RING_LIFETIME // 0 → 1 over its life
    const s = RING_MAX * (0.15 + 0.85 * (k < 1 ? 1 - (1 - k) * (1 - k) : 1)) // ease-out expand
    const v = slot * 3
    const q = slot * 4
    _park.set(rPos[v]!, rPos[v + 1]!, rPos[v + 2]!)
    _splatQuat.set(rQuat[q]!, rQuat[q + 1]!, rQuat[q + 2]!, rQuat[q + 3]!)
    _scale.setScalar(Math.max(0.0001, s))
    _mat4.compose(_park, _splatQuat, _scale)
    ringMesh.setMatrixAt(slot, _mat4)
  }

  return {
    name: 'paintball',

    init(ctx: GameContext) {
      PLANET_RADIUS = ctx.planet.radius

      const glowTex = makeGlowTexture()
      textures.push(glowTex)

      // --- ball head InstancedMesh (low-poly self-lit sphere) ---
      {
        const g = new THREE.IcosahedronGeometry(BALL_RADIUS, 1)
        const m = new THREE.MeshBasicMaterial() // self-lit, per-instance tinted
        const inst = new THREE.InstancedMesh(g, m, BALL_POOL)
        inst.name = 'paintball.heads'
        inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        inst.frustumCulled = false
        _scale.setScalar(0.0001)
        for (let i = 0; i < BALL_POOL; i++) {
          _mat4.compose(park(i), _quatIdent, _scale)
          inst.setMatrixAt(i, _mat4)
          inst.setColorAt(i, _col.setRGB(1, 1, 1))
        }
        inst.instanceMatrix.needsUpdate = true
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true
        ballMesh = inst
        group.add(inst)
        geometries.push(g)
        materials.push(m)
      }

      // --- trail Points cloud (additive, vertex-colored) ---
      {
        trailGeo = new THREE.BufferGeometry()
        for (let i = 0; i < TOTAL_TRAIL; i++) {
          tPos[i * 3 + 1] = PARK_Y
          tLife[i] = 0
        }
        trailGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3))
        trailGeo.setAttribute('color', new THREE.BufferAttribute(tCol, 3))
        const m = new THREE.PointsMaterial({
          size: BALL_RADIUS * 2.6,
          map: glowTex, // soft round sprites instead of square points
          alphaTest: 0.01,
          sizeAttenuation: true,
          vertexColors: true,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
        const points = new THREE.Points(trailGeo, m)
        points.name = 'paintball.trails'
        points.frustumCulled = false
        group.add(points)
        geometries.push(trailGeo)
        materials.push(m)
      }

      // --- splat decal InstancedMesh (flat self-lit disks) ---
      {
        const g = new THREE.CircleGeometry(0.5, 14)
        g.rotateX(-Math.PI / 2) // face the disk along +Y so _up→normal aligns it flat
        const m = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0.92,
          depthWrite: false,
          side: THREE.DoubleSide, // visible from either side as the plane circles
          polygonOffset: true, // nudge off the planet skin → no z-fighting
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        })
        const inst = new THREE.InstancedMesh(g, m, SPLAT_POOL)
        inst.name = 'paintball.splats'
        inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        inst.frustumCulled = false
        _scale.setScalar(0.0001)
        for (let i = 0; i < SPLAT_POOL; i++) {
          _mat4.compose(park(i), _quatIdent, _scale)
          inst.setMatrixAt(i, _mat4)
          inst.setColorAt(i, _col.setRGB(1, 1, 1))
          sLife[i] = 0
        }
        inst.instanceMatrix.needsUpdate = true
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true
        splatMesh = inst
        group.add(inst)
        geometries.push(g)
        materials.push(m)
      }

      // --- hit-burst ring InstancedMesh (additive flat annulus) ---
      {
        const g = new THREE.RingGeometry(0.38, 0.5, 22)
        g.rotateX(-Math.PI / 2) // align flat like the splats
        const m = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 1,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        })
        const inst = new THREE.InstancedMesh(g, m, RING_POOL)
        inst.name = 'paintball.rings'
        inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        inst.frustumCulled = false
        _scale.setScalar(0.0001)
        for (let i = 0; i < RING_POOL; i++) {
          _mat4.compose(park(i), _quatIdent, _scale)
          inst.setMatrixAt(i, _mat4)
          inst.setColorAt(i, _col.setRGB(1, 1, 1))
          rLife[i] = 0
        }
        inst.instanceMatrix.needsUpdate = true
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true
        ringMesh = inst
        ringMat = m
        group.add(inst)
        geometries.push(g)
        materials.push(m)
      }

      // --- muzzle flash sprites (pooled, additive glow) ---
      {
        for (let i = 0; i < FLASH_POOL; i++) {
          const m = new THREE.SpriteMaterial({
            map: glowTex,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.AdditiveBlending,
            opacity: 0,
          })
          const spr = new THREE.Sprite(m)
          spr.name = 'paintball.flash'
          spr.visible = false
          spr.frustumCulled = false
          spr.position.set(0, PARK_Y, 0)
          group.add(spr)
          flashes.push(spr)
          materials.push(m)
          fLife[i] = 0
        }
      }

      // --- score popup sprites (pooled, "+25" label) ---
      {
        const scoreTex = makeScoreTexture()
        textures.push(scoreTex)
        for (let i = 0; i < POPUP_POOL; i++) {
          const m = new THREE.SpriteMaterial({
            map: scoreTex,
            transparent: true,
            depthWrite: false,
            depthTest: false, // always readable on top of the action
            opacity: 0,
          })
          const spr = new THREE.Sprite(m)
          spr.name = 'paintball.popup'
          spr.visible = false
          spr.frustumCulled = false
          spr.renderOrder = 999
          spr.scale.set(POPUP_SIZE * 2, POPUP_SIZE, 1) // 2:1 label aspect
          spr.position.set(0, PARK_Y, 0)
          group.add(spr)
          popups.push(spr)
          materials.push(m)
          pLife[i] = 0
        }
      }

      // --- fire intents: shared event + keyboard F + canvas pointer-down ---
      offFire = ctx.events.on('fire', (p?: any) => {
        // Ignore the echo of our OWN emit (which carries { origin, dir }); only
        // treat a payload-less / external request as a fire intent.
        if (!p || (!p.origin && !p.dir)) firePressed = true
      })
      onKeyDown = (e: KeyboardEvent) => {
        if (e.code === 'KeyF') firePressed = true
      }
      addEventListener('keydown', onKeyDown)
      onPointerDown = () => {
        firePressed = true
      }
      domEl = ctx.renderer.domElement
      domEl.addEventListener('pointerdown', onPointerDown)

      ctx.scene.add(group)
    },

    update(dt: number, ctx: GameContext) {
      if (dt > 1 / 30) dt = 1 / 30 // resume-from-background clamp (matches Flight)

      // --- cooldown + fire (cadence scales with upgrades.fireMult) ---
      if (cooldown > 0) cooldown -= dt
      if (firePressed && cooldown <= 0) {
        const upgrades = (ctx as any).upgrades as { fireMult?: number } | undefined
        const fireMult =
          upgrades && typeof upgrades.fireMult === 'number' && upgrades.fireMult > 0
            ? upgrades.fireMult
            : 1
        let cd = BASE_COOLDOWN / fireMult
        if (cd < MIN_COOLDOWN) cd = MIN_COOLDOWN
        cooldown = cd
        spawnBall(ctx)
      }
      firePressed = false // consume the one-shot edge

      // Optional NPC targets, resolved once per frame.
      const targets = (ctx as any).npcTargets as
        | ReadonlyArray<{
            position: THREE.Vector3
            radius?: number
            alive?: boolean
            onHit?: (info?: any) => void
          }>
        | undefined
      const hasTargets = Array.isArray(targets) && targets.length > 0

      // --- integrate balls ---
      let ballsDirty = false
      const groundSurf = PLANET_RADIUS + GROUND_SKIN
      const groundSurfSq = groundSurf * groundSurf
      for (let s = 0; s < BALL_POOL; s++) {
        let life = bLife[s]!
        if (life <= 0) continue
        ballsDirty = true
        life -= dt
        const b = s * 3

        // advance on a gravity-less straight line
        bPos[b] += bVel[b]! * dt
        bPos[b + 1] += bVel[b + 1]! * dt
        bPos[b + 2] += bVel[b + 2]! * dt
        _ballPos.set(bPos[b]!, bPos[b + 1]!, bPos[b + 2]!)

        // trail sampling on a fixed cadence
        const tt = bTrailT[s]! + dt
        if (tt >= TRAIL_SPACING) {
          bTrailT[s] = 0
          sampleTrail(s)
        } else {
          bTrailT[s] = tt
        }

        bSpin[s] = bSpin[s]! + BALL_SPIN * dt

        const colorIdx = bColor[s]!
        let hit = false
        let onTarget = false

        // NPC hit test (squared distance)
        if (hasTargets) {
          for (let i = 0; i < targets!.length; i++) {
            const tgt = targets![i]!
            if (tgt.alive === false || !tgt.position) continue
            _toTarget.copy(tgt.position).sub(_ballPos)
            const r = (tgt.radius && tgt.radius > 0 ? tgt.radius : NPC_HIT_RADIUS) + BALL_RADIUS
            if (_toTarget.lengthSq() <= r * r) {
              hit = true
              onTarget = true
              spawnSplat(_ballPos, colorIdx, ctx.rand())
              spawnRing(_ballPos, colorIdx)
              spawnPopup(_ballPos)
              ctx.audio.play('splat', { volume: 0.9, rate: 1.0 + ctx.rand() * 0.18 })
              const sc = (ctx as any).score
              ;(ctx as any).score = (typeof sc === 'number' ? sc : 0) + SCORE_PER_HIT
              if (typeof tgt.onHit === 'function') {
                tgt.onHit({ pos: _ballPos, color: PAINT_COLORS[colorIdx] })
              }
              break
            }
          }
        }

        // ground splat when the ball reaches the planet surface
        if (!hit) {
          const dSq =
            bPos[b]! * bPos[b]! + bPos[b + 1]! * bPos[b + 1]! + bPos[b + 2]! * bPos[b + 2]!
          if (dSq <= groundSurfSq) {
            hit = true
            spawnSplat(_ballPos, colorIdx, ctx.rand())
            ctx.audio.play('splat', { volume: 0.55, rate: 0.85 + ctx.rand() * 0.1 })
          }
        }
        void onTarget

        if (hit) life = 0

        // write the head transform (or park if it just died)
        if (ballMesh) {
          if (life <= 0) {
            _scale.setScalar(0.0001)
            _mat4.compose(park(s), _quatIdent, _scale)
          } else {
            // pop-in scale at birth so a fresh ball blooms out of the muzzle
            const age = BALL_LIFETIME - life
            const pop = age < BALL_POP_T ? age / BALL_POP_T : 1
            _scale.setScalar(0.0001 + pop)
            // gentle tumble (varied per-ball axis via spin angle as a seed)
            _spinAxis.set(0.3, 1, 0.5).normalize()
            _spinQuat.setFromAxisAngle(_spinAxis, bSpin[s]!)
            _mat4.compose(_ballPos, _spinQuat, _scale)
          }
          ballMesh.setMatrixAt(s, _mat4)
          _col.copy(PAINT_COLORS[colorIdx]!)
          ballMesh.setColorAt(s, _col)
        }

        bLife[s] = life
      }
      if (ballsDirty && ballMesh) {
        ballMesh.instanceMatrix.needsUpdate = true
        if (ballMesh.instanceColor) ballMesh.instanceColor.needsUpdate = true
      }

      // --- fade trail points (additive → dim toward black as they age) ---
      let trailDirty = false
      for (let i = 0; i < TOTAL_TRAIL; i++) {
        let life = tLife[i]!
        if (life <= 0) continue
        trailDirty = true
        life -= dt
        const p = i * 3
        if (life <= 0) {
          tLife[i] = 0
          tPos[p + 1] = PARK_Y
          tCol[p] = 0
          tCol[p + 1] = 0
          tCol[p + 2] = 0
          continue
        }
        tLife[i] = life
        const k = life / TRAIL_POINT_LIFE // 1 → 0
        const base = PAINT_COLORS[bColor[(i / TRAIL_LEN) | 0]!]!
        tCol[p] = base.r * k
        tCol[p + 1] = base.g * k
        tCol[p + 2] = base.b * k
      }
      if (trailDirty && trailGeo) {
        ;(trailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
        ;(trailGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true
      }

      // --- age splats (pop-in then shrink-out via per-instance scale) ---
      let splatDirty = false
      for (let i = 0; i < SPLAT_POOL; i++) {
        const life = sLife[i]!
        if (life <= 0) continue
        splatDirty = true
        const next = life - dt
        sLife[i] = next > 0 ? next : 0
        seatSplat(i)
      }
      if (splatDirty && splatMesh) {
        splatMesh.instanceMatrix.needsUpdate = true
      }

      // --- age hit-burst rings (expand + fade) ---
      let ringDirty = false
      let ringOpacity = 0
      let ringAny = false
      for (let i = 0; i < RING_POOL; i++) {
        const life = rLife[i]!
        if (life <= 0) continue
        ringDirty = true
        ringAny = true
        const next = life - dt
        rLife[i] = next > 0 ? next : 0
        seatRing(i)
        // track the brightest live ring to drive the shared material opacity
        const o = (next > 0 ? next : 0) / RING_LIFETIME
        if (o > ringOpacity) ringOpacity = o
      }
      if (ringDirty && ringMesh) {
        ringMesh.instanceMatrix.needsUpdate = true
        if (ringMat) ringMat.opacity = ringAny ? Math.max(0.18, ringOpacity) : 0
      }

      // --- muzzle flashes (fast scale-up + fade additive) ---
      for (let i = 0; i < FLASH_POOL; i++) {
        const life = fLife[i]!
        if (life <= 0) continue
        const next = life - dt
        const spr = flashes[i]!
        if (next <= 0) {
          fLife[i] = 0
          spr.visible = false
          spr.material.opacity = 0
          spr.position.set(0, PARK_Y, 0)
          continue
        }
        fLife[i] = next
        const k = next / FLASH_LIFETIME // 1 → 0
        spr.material.opacity = k
        spr.scale.setScalar(FLASH_SIZE * (0.6 + 0.6 * (1 - k))) // bloom out as it fades
      }

      // --- score popups (rise radially outward + fade, billboarded) ---
      for (let i = 0; i < POPUP_POOL; i++) {
        const life = pLife[i]!
        if (life <= 0) continue
        const next = life - dt
        const spr = popups[i]!
        if (next <= 0) {
          pLife[i] = 0
          spr.visible = false
          spr.material.opacity = 0
          spr.position.set(0, PARK_Y, 0)
          continue
        }
        pLife[i] = next
        const k = 1 - next / POPUP_LIFETIME // 0 → 1 (progress)
        const v = i * 3
        spr.position.set(
          pPos[v]! + pDir[v]! * POPUP_RISE * k,
          pPos[v + 1]! + pDir[v + 1]! * POPUP_RISE * k,
          pPos[v + 2]! + pDir[v + 2]! * POPUP_RISE * k,
        )
        // quick pop-in then linger then fade
        const grow = k < 0.18 ? k / 0.18 : 1
        const fade = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1
        spr.material.opacity = Math.min(1, grow) * Math.max(0, fade)
        const sc = POPUP_SIZE * (0.7 + 0.3 * Math.min(1, grow))
        spr.scale.set(sc * 2, sc, 1)
      }
    },

    dispose() {
      if (offFire) {
        offFire()
        offFire = null
      }
      if (onKeyDown) {
        removeEventListener('keydown', onKeyDown)
        onKeyDown = null
      }
      if (onPointerDown && domEl) {
        domEl.removeEventListener('pointerdown', onPointerDown)
      }
      onPointerDown = null
      domEl = null
      group.parent?.remove(group)
      for (const g of geometries) g.dispose()
      geometries.length = 0
      for (const m of materials) m.dispose()
      materials.length = 0
      for (const t of textures) t.dispose()
      textures.length = 0
      flashes.length = 0
      popups.length = 0
      ballMesh = null
      trailGeo = null
      splatMesh = null
      ringMesh = null
      ringMat = null
    },
  }
}
