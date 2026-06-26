import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { damp } from '../plane/flight'

/**
 * Collectibles — the bread-and-butter XP pickups that float just above the
 * planet surface and pull toward the plane when you fly near.
 *
 * Four families (TinySkies-faithful, our art):
 *   - box     Box geometry, soft mint crate,   xp 1   (common)
 *   - lantern Cylinder + cap, warm glow,        xp 3
 *   - diamond Octahedron, holo cyan glint,      xp 5
 *   - ring    Torus to fly *through*,           xp 8   (rare)
 *
 * Each one bobs on its surface normal and spins. Diamonds *glint* (a fast
 * emissive sparkle that catches the eye), lanterns breathe a warm glow, rings
 * pulse + tumble so the hole reads as a target to thread.
 *
 * MAGNET: once the plane is within `magnetRange` (read from
 * (ctx as any).upgrades?.magnet, default 6) the item starts homing. The pull
 * EASES IN — it lingers for a beat (a little "pop" of scale as it wakes up),
 * then accelerates toward the plane, so the grab feels deliberate, not snappy.
 *
 * COLLECT JUICE: SFX (pitch climbs with your combo), a pooled particle burst,
 * an expanding sparkle RING shockwave, and a COMBO counter — pick things up in
 * quick succession and the rate/pitch/burst all swell. Emits the same
 * `collect` {type,xp,pos} event the rest of the game banks XP from.
 *
 * CHASE: items sometimes spawn in TRAILS or CLUSTERS (a breadcrumb line or a
 * little constellation) so there's always a tempting string to chase down.
 *
 * Perf: every collectible is a real pooled Mesh (so the magnet can move each
 * independently) but materials are shared per family → only 4 collectible
 * draw families + 1 pooled particle system + 1 pooled sparkle-ring system. All
 * math uses module-scoped temps and squared distances; update() allocates zero.
 */

// ----- tuning ---------------------------------------------------------------

const ALIVE_COUNT = 60 // steady population across the whole planet
const DEFAULT_MAGNET_RANGE = 6 // world units; overridden by upgrades.magnet
const COLLECT_RADIUS = 2.2 // pick-up proximity (world units)
const MAGNET_PULL_K = 6.0 // damp() stiffness once the magnet is fully awake
const MAGNET_WAKE_TIME = 0.16 // seconds of ease-in before full pull (anticipation)
const SPAWN_MIN_ALT = 9 // float height band above the surface …
const SPAWN_MAX_ALT = 26 // … so items sit in comfortable flight altitudes
const BOB_AMPLITUDE = 0.6 // vertical bob (along surface normal)
const SPIN_RATE = 1.1 // rad/s base spin about the local up

// Combo: pickups within this window keep the chain alive.
const COMBO_WINDOW = 2.4 // seconds between pickups before the chain resets
const COMBO_MAX = 12 // pitch/juice saturates here

// Cluster / trail spawning: when an item respawns it sometimes seeds a few of
// its neighbours into a chase-able shape instead of scattering them.
const CLUSTER_CHANCE = 0.28 // probability a respawn seeds a group
const CLUSTER_MIN = 3
const CLUSTER_MAX = 5

// Particle burst pool.
const BURST_POOL = 8 // simultaneous bursts (plenty at 60fps)
const BURST_PARTICLES = 12 // points per burst
const BURST_LIFETIME = 0.6 // seconds
const BURST_SPEED = 9 // initial outward speed
const BURST_GRAVITY = 14 // pull back toward the planet center

// Sparkle-ring shockwave pool (a flat expanding ring at each pickup).
const SRING_POOL = 6 // simultaneous shockwaves
const SRING_LIFETIME = 0.42 // seconds
const SRING_START = 0.4 // starting radius scale
const SRING_END = 4.2 // ending radius scale

// Squared thresholds (no sqrt in the hot loop).
const COLLECT_RADIUS_SQ = COLLECT_RADIUS * COLLECT_RADIUS

// ----- collectible kinds ----------------------------------------------------

type Kind = 'box' | 'diamond' | 'lantern' | 'ring'

interface KindDef {
  type: Kind
  xp: number
  weight: number // relative spawn frequency
}

const KIND_DEFS: readonly KindDef[] = [
  { type: 'box', xp: 1, weight: 50 },
  { type: 'lantern', xp: 3, weight: 25 },
  { type: 'diamond', xp: 5, weight: 18 },
  { type: 'ring', xp: 8, weight: 7 },
]

// Accent colors not in PAL, authored sRGB & color-managed exactly like PAL.
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const BOX_COLOR = srgb(0xa7e8c8) // soft mint crate (cool, recedes vs coral plane)
const LANTERN_COLOR = srgb(0xffcf8a) // warm paper-lantern glow
const LANTERN_EMISSIVE = srgb(0xff9d4d)

// ----- per-instance state ----------------------------------------------------

interface Item {
  mesh: THREE.Mesh
  def: KindDef
  // surface anchor: unit direction + the altitude this item floats at
  dir: THREE.Vector3
  altitude: number
  bobPhase: number // desync the bob between items
  spinSign: number // +1 / -1 so they don't all spin the same way
  glintPhase: number // desync the diamond glint / ring pulse
  baseScale: number // family base scale (mesh.scale settles back to this)
  magnetized: boolean // currently being pulled toward the plane
  wake: number // 0→1 magnet ease-in (anticipation before full pull)
  pop: number // 0→1 spawn pop-in, drives a little scale overshoot
}

// ----- module-scoped temps (ZERO per-frame allocation) ----------------------

const _up = new THREE.Vector3(0, 1, 0)
const _planePos = new THREE.Vector3()
const _toPlane = new THREE.Vector3()
const _normal = new THREE.Vector3()
const _target = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _spin = new THREE.Quaternion()
const _scratchDir = new THREE.Vector3()
const _ringQuat = new THREE.Quaternion()
const _zAxis = new THREE.Vector3(0, 0, 1)
const _tintA = new THREE.Color()
const _tintB = new THREE.Color()
const _white = new THREE.Color(1, 1, 1)

// Smoothstep for buttery eases.
const smooth = (t: number) => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

export function createCollectiblesSystem(): GameSystem {
  // Disposables captured for dispose().
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  const group = new THREE.Group()
  group.name = 'collectibles'

  const items: Item[] = []

  // --- particle burst pool (one shared Points cloud) ---
  let burstPoints: THREE.Points | null = null
  let burstGeo: THREE.BufferGeometry | null = null
  let burstMat: THREE.PointsMaterial | null = null
  const TOTAL_P = BURST_POOL * BURST_PARTICLES
  const pPos = new Float32Array(TOTAL_P * 3)
  const pVel = new Float32Array(TOTAL_P * 3)
  const pLife = new Float32Array(TOTAL_P) // remaining seconds, 0 = dead
  let nextBurst = 0 // round-robin burst slot

  // --- sparkle-ring shockwave pool (flat rings, additive) ---
  const srings: THREE.Mesh[] = []
  const sringLife = new Float32Array(SRING_POOL) // remaining seconds, 0 = dead
  let nextSRing = 0
  let sringGeo: THREE.RingGeometry | null = null

  // Shared geometry+material builders, created once at init.
  const matForKind = new Map<Kind, THREE.MeshStandardMaterial | THREE.MeshLambertMaterial>()
  const geoForKind = new Map<Kind, THREE.BufferGeometry>()

  // Per-family base scale so the pop-in overshoot returns to the right size.
  const SCALE_FOR: Record<Kind, number> = { box: 1, lantern: 1, diamond: 1, ring: 1 }

  // Live combo state.
  let combo = 0
  let comboTimer = 0 // counts down; reaching 0 resets the combo

  // ---- deterministic uniform point on the unit sphere into `out` ----
  function randomDir(rand: () => number, out: THREE.Vector3): THREE.Vector3 {
    const z = rand() * 2 - 1
    const t = rand() * Math.PI * 2
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    out.set(r * Math.cos(t), z, r * Math.sin(t))
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0)
    else out.normalize()
    return out
  }

  // ---- weighted kind pick ----
  let totalWeight = 0
  for (const d of KIND_DEFS) totalWeight += d.weight
  function pickKind(rand: () => number): KindDef {
    let r = rand() * totalWeight
    for (const d of KIND_DEFS) {
      r -= d.weight
      if (r <= 0) return d
    }
    return KIND_DEFS[KIND_DEFS.length - 1]!
  }

  // ---- assign an item a family + reset its juice state ----
  function dressItem(item: Item, def: KindDef): void {
    item.def = def
    item.mesh.geometry = geoForKind.get(def.type)!
    item.mesh.material = matForKind.get(def.type)!
    item.baseScale = SCALE_FOR[def.type]
    item.magnetized = false
    item.wake = 0
    item.pop = 0 // triggers the spawn pop-in overshoot
    item.mesh.visible = true
  }

  // ---- (re)seat an item at a fresh random surface anchor ----
  // When `seedClusters` is true, a respawn may also re-seat a few neighbours
  // along a trail / in a cluster around this point, giving a chase to follow.
  function respawn(item: Item, ctx: GameContext, seedClusters = true): void {
    dressItem(item, pickKind(ctx.rand))

    randomDir(ctx.rand, item.dir)
    item.altitude = SPAWN_MIN_ALT + ctx.rand() * (SPAWN_MAX_ALT - SPAWN_MIN_ALT)
    item.bobPhase = ctx.rand() * Math.PI * 2
    item.spinSign = ctx.rand() < 0.5 ? -1 : 1
    item.glintPhase = ctx.rand() * Math.PI * 2

    // Seat it immediately so it never renders a frame at the origin.
    seatItem(item, ctx.elapsed())

    if (seedClusters && ctx.rand() < CLUSTER_CHANCE) {
      seedTrail(item, ctx)
    }
  }

  // ---- seed a short breadcrumb trail / cluster anchored on `head` ----
  // Pulls a handful of *other* idle items over to neighbour `head`, walking a
  // gentle tangent so they read as a line/arc to fly along.
  function seedTrail(head: Item, ctx: GameContext): void {
    const count =
      CLUSTER_MIN + Math.floor(ctx.rand() * (CLUSTER_MAX - CLUSTER_MIN + 1))

    // Build an orthonormal tangent basis at the head direction (no alloc:
    // reuse temps). _normal = head dir, _scratchDir = tangent, _target = bitan.
    _normal.copy(head.dir)
    _scratchDir.copy(_up)
    if (Math.abs(_normal.dot(_up)) > 0.92) _scratchDir.set(1, 0, 0)
    _scratchDir.crossVectors(_normal, _scratchDir).normalize()
    _target.crossVectors(_normal, _scratchDir).normalize()

    // Random walk direction in the tangent plane.
    const ang = ctx.rand() * Math.PI * 2
    const tx = Math.cos(ang)
    const ty = Math.sin(ang)
    const step = 0.05 + ctx.rand() * 0.04 // angular spacing along the trail
    const altBase = head.altitude

    let placed = 0
    for (let i = 0; i < items.length && placed < count; i++) {
      const it = items[i]!
      if (it === head || it.magnetized) continue
      placed++
      const k = placed
      // March along the tangent + bitangent, drifting outward — sphere-walk
      // via small angular steps so the trail bends gently across the surface.
      _normal
        .copy(head.dir)
        .addScaledVector(_scratchDir, tx * step * k)
        .addScaledVector(_target, ty * step * k)
        .normalize()
      it.dir.copy(_normal)
      it.altitude = altBase + (ctx.rand() - 0.5) * 3
      it.bobPhase = ctx.rand() * Math.PI * 2
      it.glintPhase = ctx.rand() * Math.PI * 2
      it.pop = 0 // pop-in so the trail materialises with a flourish
      it.magnetized = false
      it.wake = 0
      it.mesh.visible = true
      seatItem(it, ctx.elapsed())
    }
  }

  // Planet base radius, captured at init so seatItem() needs no ctx lookup.
  let PLANET_BASE_RADIUS = 100

  // ---- place an item's mesh at its current bobbed surface position ----
  function seatItem(item: Item, elapsed: number): void {
    _normal.copy(item.dir)
    const bob = Math.sin(elapsed * 1.6 + item.bobPhase) * BOB_AMPLITUDE
    const r = PLANET_BASE_RADIUS + item.altitude + bob
    item.mesh.position.copy(_normal).multiplyScalar(r)
    // Orient: local +Y → surface normal, plus a continuous spin about that up.
    _quat.setFromUnitVectors(_up, _normal)
    _spin.setFromAxisAngle(_up, elapsed * SPIN_RATE * item.spinSign)
    _quat.multiply(_spin)
    item.mesh.quaternion.copy(_quat)
  }

  // ---- fire a pooled particle burst at a world position, tinted `color` ----
  function spawnBurst(
    at: THREE.Vector3,
    color: THREE.Color,
    rand: () => number,
    intensity: number,
  ): void {
    if (!burstMat) return
    burstMat.color.copy(color)
    const slot = nextBurst
    nextBurst = (nextBurst + 1) % BURST_POOL
    const base = slot * BURST_PARTICLES
    // radial-ish outward normal so particles puff away from the planet too
    _normal.copy(at).normalize()
    const speed = BURST_SPEED * (0.85 + intensity * 0.55)
    for (let i = 0; i < BURST_PARTICLES; i++) {
      const p = (base + i) * 3
      pPos[p] = at.x
      pPos[p + 1] = at.y
      pPos[p + 2] = at.z
      // random direction biased outward along the surface normal
      randomDir(rand, _scratchDir)
      _scratchDir.addScaledVector(_normal, 0.8).normalize()
      const sp = speed * (0.6 + rand() * 0.6)
      pVel[p] = _scratchDir.x * sp
      pVel[p + 1] = _scratchDir.y * sp
      pVel[p + 2] = _scratchDir.z * sp
      pLife[base + i] = BURST_LIFETIME
    }
  }

  // ---- fire a pooled expanding sparkle-ring shockwave at a pickup point ----
  function spawnSparkleRing(at: THREE.Vector3, color: THREE.Color, intensity: number): void {
    const ring = srings[nextSRing]
    if (!ring) return
    const slot = nextSRing
    nextSRing = (nextSRing + 1) % SRING_POOL
    sringLife[slot] = SRING_LIFETIME
    ring.position.copy(at)
    // Lay the ring flat against the surface (its plane ⟂ the surface normal).
    _normal.copy(at).normalize()
    _ringQuat.setFromUnitVectors(_up, _normal)
    // RingGeometry lies in XY; rotate its +Z to face the normal instead.
    _spin.setFromUnitVectors(_zAxis, _up)
    ring.quaternion.copy(_ringQuat).multiply(_spin)
    const s = SRING_START * (1 + intensity * 0.4)
    ring.scale.setScalar(s)
    ring.visible = true
    const mat = ring.material as THREE.MeshBasicMaterial
    mat.color.copy(color)
  }

  return {
    name: 'collectibles',

    init(ctx: GameContext) {
      PLANET_BASE_RADIUS = ctx.planet.radius

      // ---------------------------------------------------------------
      // Build the four shared geometries + materials (flat-shaded, cozy).
      // ---------------------------------------------------------------

      // BOX — chunky little crate.
      {
        const g = new THREE.BoxGeometry(1.6, 1.6, 1.6)
        const m = new THREE.MeshLambertMaterial({
          color: BOX_COLOR,
          emissive: BOX_COLOR,
          emissiveIntensity: 0.12, // a whisper of self-light so it never goes muddy
          flatShading: true,
        })
        geometries.push(g)
        materials.push(m)
        geoForKind.set('box', g)
        matForKind.set('box', m)
        SCALE_FOR.box = 1
      }

      // DIAMOND — octahedron with a holo cyan glint (emissive so it sparkles
      // even in shadow; keeps within the ≤3-light budget by self-lighting).
      {
        const g = new THREE.OctahedronGeometry(1.25, 0)
        const m = new THREE.MeshStandardMaterial({
          color: PAL.gem,
          emissive: PAL.gem,
          emissiveIntensity: 0.55,
          roughness: 0.12,
          metalness: 0.0,
          flatShading: true,
        })
        geometries.push(g)
        materials.push(m)
        geoForKind.set('diamond', g)
        matForKind.set('diamond', m)
        SCALE_FOR.diamond = 1
      }

      // LANTERN — squat cylinder body; warm self-lit glow that breathes.
      {
        const g = new THREE.CylinderGeometry(0.85, 0.95, 1.7, 8, 1)
        const m = new THREE.MeshStandardMaterial({
          color: LANTERN_COLOR,
          emissive: LANTERN_EMISSIVE,
          emissiveIntensity: 0.5,
          roughness: 0.6,
          metalness: 0.0,
          flatShading: true,
        })
        geometries.push(g)
        materials.push(m)
        geoForKind.set('lantern', g)
        matForKind.set('lantern', m)
        SCALE_FOR.lantern = 1
      }

      // RING — torus you fly through; cool gem-cyan, lightly self-lit so the
      // hole reads clearly against the green planet, and it pulses as a target.
      {
        const g = new THREE.TorusGeometry(2.2, 0.32, 8, 20)
        const m = new THREE.MeshStandardMaterial({
          color: PAL.gem,
          emissive: PAL.gem,
          emissiveIntensity: 0.4,
          roughness: 0.35,
          metalness: 0.0,
          flatShading: true,
        })
        geometries.push(g)
        materials.push(m)
        geoForKind.set('ring', g)
        matForKind.set('ring', m)
        SCALE_FOR.ring = 1
      }

      // ---------------------------------------------------------------
      // Allocate the item pool ONCE, then seat each via respawn().
      // (Seed clusters AFTER all items exist so trails have neighbours.)
      // ---------------------------------------------------------------
      for (let i = 0; i < ALIVE_COUNT; i++) {
        const def = KIND_DEFS[0]!
        const mesh = new THREE.Mesh(geoForKind.get(def.type)!, matForKind.get(def.type)!)
        mesh.name = `collectible.${i}`
        mesh.frustumCulled = true
        mesh.castShadow = false
        mesh.receiveShadow = false
        group.add(mesh)

        const item: Item = {
          mesh,
          def,
          dir: new THREE.Vector3(0, 1, 0),
          altitude: SPAWN_MIN_ALT,
          bobPhase: 0,
          spinSign: 1,
          glintPhase: 0,
          baseScale: 1,
          magnetized: false,
          wake: 0,
          pop: 1,
        }
        items.push(item)
        // No cluster seeding during the initial fill — pool isn't ready yet.
        respawn(item, ctx, false)
      }

      // ---------------------------------------------------------------
      // Pooled particle burst system (one Points cloud, additive glow).
      // ---------------------------------------------------------------
      burstGeo = new THREE.BufferGeometry()
      burstGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
      pLife.fill(0)
      for (let i = 0; i < TOTAL_P; i++) {
        pPos[i * 3 + 1] = -100000 // park dead particles far below the world
      }
      burstMat = new THREE.PointsMaterial({
        color: PAL.gem,
        size: 1.7,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
      burstPoints = new THREE.Points(burstGeo, burstMat)
      burstPoints.name = 'collectibles.bursts'
      burstPoints.frustumCulled = false
      burstPoints.renderOrder = 2
      group.add(burstPoints)
      geometries.push(burstGeo)
      materials.push(burstMat)

      // ---------------------------------------------------------------
      // Pooled sparkle-ring shockwaves (thin flat rings, additive). One
      // shared geometry + per-instance materials (so colors differ); the
      // pool is tiny (SRING_POOL) so this stays cheap.
      // ---------------------------------------------------------------
      sringGeo = new THREE.RingGeometry(0.78, 1.0, 24)
      geometries.push(sringGeo)
      for (let i = 0; i < SRING_POOL; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: PAL.gem,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        })
        materials.push(mat)
        const ring = new THREE.Mesh(sringGeo, mat)
        ring.name = `collectibles.sring.${i}`
        ring.frustumCulled = false
        ring.visible = false
        ring.renderOrder = 2
        srings.push(ring)
        group.add(ring)
      }
      sringLife.fill(0)

      ctx.scene.add(group)
    },

    update(dt: number, ctx: GameContext) {
      const elapsed = ctx.elapsed()
      _planePos.copy(ctx.player.obj.position)

      // Combo decay — let the chain lapse when the player stops grabbing.
      if (combo > 0) {
        comboTimer -= dt
        if (comboTimer <= 0) {
          combo = 0
          comboTimer = 0
        }
      }

      // Resolve current magnet range from upgrades (default if unset).
      const upgrades = (ctx as any).upgrades as { magnet?: number } | undefined
      const magnetRange =
        upgrades && typeof upgrades.magnet === 'number' && upgrades.magnet > 0
          ? upgrades.magnet
          : DEFAULT_MAGNET_RANGE
      const magnetRangeSq = magnetRange * magnetRange

      // -------- collectibles: bob/spin, glint, magnet pull, pick-up --------
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!

        // Spawn pop-in: scale eases up from small, overshoots past base, then
        // settles back to 1 (a juicy "appear" flourish on respawn/trail-seed).
        if (item.pop < 1) {
          item.pop = Math.min(1, item.pop + dt * 4.5)
        }
        const pop = item.pop
        // Base ease 0.3→1 plus a sin hump that peaks ~+0.16 mid-flight.
        const entrance = pop < 1 ? 0.3 + smooth(pop) * 0.7 + Math.sin(pop * Math.PI) * 0.16 : 1

        if (item.magnetized) {
          // Ease the magnet in: a brief "wind-up", then full pull. This makes
          // the grab feel intentional and gives a satisfying acceleration.
          item.wake = Math.min(1, item.wake + dt / MAGNET_WAKE_TIME)
          const pull = MAGNET_PULL_K * smooth(item.wake)
          _target.copy(_planePos)
          item.mesh.position.lerp(_target, damp(pull, dt))

          // Spin faster + tilt-tumble while homing for life.
          _spin.setFromAxisAngle(_up, dt * SPIN_RATE * 3 * item.spinSign)
          item.mesh.quaternion.multiply(_spin)

          // Squash toward the plane: stretch a touch as it accelerates in.
          const homeScale = item.baseScale * (1 + 0.18 * smooth(item.wake))
          item.mesh.scale.setScalar(homeScale)

          // Glint hot while being grabbed.
          applyGlint(item, elapsed, 1)

          _toPlane.copy(_planePos).sub(item.mesh.position)
          if (_toPlane.lengthSq() <= COLLECT_RADIUS_SQ) {
            collect(item, ctx)
          }
          continue
        }

        // Idle: seat on its bobbing surface anchor.
        seatItem(item, elapsed)

        // Scale: pop-in entrance while pop<1, then steady base scale.
        item.mesh.scale.setScalar(item.baseScale * entrance)

        // Per-family living detail: glint / breathe / pulse.
        applyGlint(item, elapsed, 0)

        // Distance to plane (squared) — decide whether to start homing.
        _toPlane.copy(_planePos).sub(item.mesh.position)
        const dSq = _toPlane.lengthSq()
        if (dSq <= magnetRangeSq) {
          item.magnetized = true
          item.wake = 0
        }
      }

      // -------- pooled VFX: bursts + sparkle rings --------
      stepBursts(dt)
      stepSparkleRings(dt)

      // ---- collect a single item: SFX + VFX + event + combo + respawn ----
      function collect(item: Item, c: GameContext): void {
        const def = item.def

        // Advance the combo chain (rapid pickups stack).
        combo = Math.min(COMBO_MAX, combo + 1)
        comboTimer = COMBO_WINDOW
        const comboT = (combo - 1) / (COMBO_MAX - 1) // 0→1

        // SFX — base pitch per family, then climbs with the combo so a streak
        // sounds like a rising arpeggio.
        const basePitch = def.type === 'ring' ? 1.25 : def.type === 'diamond' ? 1.12 : 1.0
        c.audio.play('collect', {
          volume: 0.85 + comboT * 0.15,
          rate: basePitch + comboT * 0.55,
        })

        // VFX tint by family.
        const tint =
          def.type === 'diamond' || def.type === 'ring'
            ? _tintA.copy(PAL.gem)
            : def.type === 'lantern'
              ? _tintA.copy(LANTERN_COLOR)
              : _tintA.copy(BOX_COLOR)
        // Whiten the tint as the combo climbs so streaks read hotter.
        _tintB.copy(tint).lerp(_white, comboT * 0.5)

        const intensity = 0.4 + comboT
        spawnBurst(item.mesh.position, _tintB, c.rand, intensity)
        spawnSparkleRing(item.mesh.position, _tintB, intensity)

        // Event for XP / leveling / quests (unchanged payload shape).
        c.events.emit('collect', { type: def.type, xp: def.xp, pos: item.mesh.position })

        // Reset scale before respawn so the next dress starts clean, then
        // respawn elsewhere (may seed a fresh chase-able trail).
        item.mesh.scale.setScalar(item.baseScale)
        respawn(item, c)
      }
    },

    dispose() {
      group.parent?.remove(group)
      for (const item of items) {
        item.mesh.geometry = undefined as unknown as THREE.BufferGeometry
      }
      items.length = 0
      srings.length = 0
      for (const g of geometries) g.dispose()
      geometries.length = 0
      for (const m of materials) m.dispose()
      materials.length = 0
      geoForKind.clear()
      matForKind.clear()
      burstPoints = null
      burstGeo = null
      burstMat = null
      sringGeo = null
    },
  }

  // ---- per-family living glint / breathe / pulse (cheap, no alloc) ----
  // `boost` (0 idle, 1 while being grabbed) makes the glint hotter on pickup.
  function applyGlint(item: Item, elapsed: number, boost: number): void {
    const mat = item.mesh.material as THREE.MeshStandardMaterial | THREE.MeshLambertMaterial
    const std = (mat as THREE.MeshStandardMaterial)
    switch (item.def.type) {
      case 'diamond': {
        // Fast, sharp sparkle: a couple of stacked sines for a twinkly catch.
        const a = Math.sin(elapsed * 7 + item.glintPhase)
        const b = Math.sin(elapsed * 11.3 + item.glintPhase * 1.7)
        const glint = 0.45 + 0.35 * (a * 0.6 + b * 0.4)
        std.emissiveIntensity = glint + boost * 0.6
        break
      }
      case 'lantern': {
        // Warm breathing glow.
        const g = 0.45 + 0.18 * Math.sin(elapsed * 2.2 + item.glintPhase)
        std.emissiveIntensity = g + boost * 0.4
        break
      }
      case 'ring': {
        // Pulse the emissive so the hoop reads as a "thread me" target.
        const g = 0.4 + 0.22 * Math.sin(elapsed * 3.0 + item.glintPhase)
        std.emissiveIntensity = g + boost * 0.5
        break
      }
      default:
        // box: leave its whisper-glow constant.
        break
    }
  }

  // ---- integrate the pooled particle bursts (no allocation) ----
  function stepBursts(dt: number): void {
    if (!burstGeo) return
    let anyAlive = false
    for (let i = 0; i < TOTAL_P; i++) {
      let life = pLife[i]!
      if (life <= 0) continue
      anyAlive = true
      life -= dt
      const p = i * 3
      if (life <= 0) {
        pLife[i] = 0
        pPos[p + 1] = -100000 // park it out of sight
        continue
      }
      pLife[i] = life
      // gravity toward planet center (pull velocity inward along position dir)
      const px = pPos[p]!
      const py = pPos[p + 1]!
      const pz = pPos[p + 2]!
      const len = Math.sqrt(px * px + py * py + pz * pz)
      if (len > 1e-4) {
        const g = (BURST_GRAVITY * dt) / len
        pVel[p] -= px * g
        pVel[p + 1] -= py * g
        pVel[p + 2] -= pz * g
      }
      pPos[p] += pVel[p]! * dt
      pPos[p + 1] += pVel[p + 1]! * dt
      pPos[p + 2] += pVel[p + 2]! * dt
    }
    if (anyAlive) {
      ;(burstGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    }
  }

  // ---- expand + fade the pooled sparkle-ring shockwaves (no allocation) ----
  function stepSparkleRings(dt: number): void {
    for (let i = 0; i < SRING_POOL; i++) {
      const life = sringLife[i]!
      if (life <= 0) continue
      const next = life - dt
      const ring = srings[i]!
      if (next <= 0) {
        sringLife[i] = 0
        ring.visible = false
        ;(ring.material as THREE.MeshBasicMaterial).opacity = 0
        continue
      }
      sringLife[i] = next
      const t = 1 - next / SRING_LIFETIME // 0→1 progress
      const e = smooth(t)
      const scale = SRING_START + (SRING_END - SRING_START) * e
      ring.scale.setScalar(scale)
      // Bright snap then fade — a fast attack, gentle release.
      const op = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82
      ;(ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, op) * 0.9
    }
  }
}
