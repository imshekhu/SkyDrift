import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { damp } from '../plane/flight'

/**
 * NpcLife — a small LIVING WORLD layered over the planet. Everything here is
 * cheap (a handful of InstancedMeshes, shared phase offsets, zero per-frame
 * allocation) so it animates for free on mobile:
 *
 *   • BIRD FLOCKS  — a few flocks, each a cloud of instanced low-poly birds that
 *                    drift along a tilted great-circle and BOID toward their
 *                    flock: cohesion to the centroid + cheap intra-flock
 *                    SEPARATION so they fan out and never stack. They bank into
 *                    turns and flap via a per-bird sine phase.
 *
 *   • OCEAN FISH   — instanced fish that live in small SCHOOLS over a shared
 *                    ocean tile, mill about just under the surface, and ARC out
 *                    on a ballistic hop — kicking a ring of foam particles on
 *                    take-off AND on splash-down.
 *
 *   • NPC PLANES   — a couple of wandering craft following their own great
 *                    circles, each leaving a fading vapour TRAIL of pooled
 *                    puffs. Their live positions are published to
 *                    (ctx as any).npcTargets so the Paintball system can hit
 *                    them; a hit makes them "puff" and respawn elsewhere.
 *
 *   • BOATS        — little boats bobbing + sailing on the ocean, each dragging
 *                    a pooled V-WAKE of foam quads behind the bow.
 *
 *   • CAPYBARAS    — capybaras sitting peacefully on land, breathing with a slow
 *                    scale pulse and idly LOOKING AROUND (a lazy yaw sway).
 *
 * Particle families (splash / wake / trail) are themselves single instanced
 * draw-calls with fixed pools — capped, recycled, zero per-frame allocation.
 *
 * Placement uses ctx.planet.surfacePoint/heightAt at INIT only (those allocate).
 * Per-frame we reuse module-scoped temps and write instance matrices in place.
 */

// ── Counts — deliberately modest for perf. Each family = one draw call. ───────
const FLOCK_COUNT = 3 // number of bird flocks
const BIRDS_PER_FLOCK = 9 // birds in each flock
const BIRD_COUNT = FLOCK_COUNT * BIRDS_PER_FLOCK

const SCHOOL_COUNT = 4 // ocean fish schools
const FISH_PER_SCHOOL = 4 // fish per school
const FISH_COUNT = SCHOOL_COUNT * FISH_PER_SCHOOL // ocean fish (hop out of the water)
const NPC_PLANE_COUNT = 2 // wandering NPC craft (paintball targets)
const BOAT_COUNT = 5 // bobbing boats on the sea
const CAPY_COUNT = 2 // capybaras chilling on land

// Particle pools (one instanced draw-call each).
const SPLASH_POOL = 28 // foam droplets kicked by fish hops
const WAKE_POOL = BOAT_COUNT * 7 // V-wake foam quads trailing boats
const TRAIL_POOL = NPC_PLANE_COUNT * 9 // vapour puffs behind NPC planes

// ── Flight bands / motion tuning (world units; planet radius is 100). ─────────
const BIRD_ALT_MIN = 22
const BIRD_ALT_MAX = 40
const BIRD_ANGULAR_SPEED = 0.14 // rad/s of the flock around its great circle
const BIRD_SPREAD = 7 // local jitter radius of birds around the centroid
const BIRD_SEPARATION = 2.6 // min comfortable gap between flockmates
const BIRD_FLAP_HZ = 6.5

const FISH_SCHOOL_SPREAD = 3.0 // how far schoolmates mill from the tile anchor
const FISH_ALT = 0.4 // idle depth just beneath the water shell
const FISH_HOP_HEIGHT = 6.5 // peak height of an arc above the surface
const FISH_HOP_TIME = 1.15 // seconds airborne per hop
const FISH_IDLE_MIN = 2.2 // min seconds between hops
const FISH_IDLE_MAX = 6.5

const PLANE_ALT = 30
const PLANE_ANGULAR_SPEED = 0.18 // rad/s along the NPC's great circle
const PLANE_HIT_RADIUS = 4.5 // paintball collision radius
const PLANE_RESPAWN_DELAY = 2.4 // seconds a "puffed" plane stays hidden
const PLANE_TRAIL_SPACING = 0.18 // seconds between vapour puffs
const PLANE_TRAIL_LIFE = 1.5 // seconds a puff lives

const BOAT_ALT = 0.2 // sit on the water shell
const BOAT_ANGULAR_SPEED = 0.012 // very slow drift along its sea great-circle
const BOAT_BOB_HZ = 0.6
const BOAT_WAKE_SPACING = 0.5 // seconds between wake foam drops
const BOAT_WAKE_LIFE = 2.6 // seconds a wake quad lives

const CAPY_BREATHE_HZ = 0.5
const CAPY_LOOK_HZ = 0.12 // how often a capy lazily turns its gaze

const SPLASH_LIFE = 0.6 // seconds a foam droplet lives

// ── Accent colors (authored sRGB, color-managed like PAL). The coral plane
//    body stays the world's ONLY pure-coral object, so NPC craft avoid coral. ─
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const BIRD_BODY = srgb(0xf6f0e2) // soft cream gull
const BIRD_WING = srgb(0xb9c4d6) // dusty blue-grey wingtips
const FISH_BODY = srgb(0xff9ec4) // pastel salmon-pink
const PLANE_BODY = srgb(0x8fd2c4) // mint — clearly NOT the coral player plane
const PLANE_WING = srgb(0xfff2d6) // warm cream wings (PAL.sun-adjacent)
const BOAT_HULL = srgb(0xc98a5e) // warm woody hull
const BOAT_SAIL = srgb(0xfdf3e3) // cream sail
const CAPY_FUR = srgb(0xb98a5a) // capybara brown
const CAPY_SNOUT = srgb(0x8a6446) // darker muzzle
const FOAM = srgb(0xf2fbff) // sea-foam white (splash + wake)
const VAPOUR = srgb(0xeef6fb) // pale vapour puff (plane trail)

// Reusable scratch — declared once, never inside update(). ────────────────────
const _pos = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _up = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _sep = new THREE.Vector3()
const _centroid = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _spin = new THREE.Quaternion()
const _scale = new THREE.Vector3(1, 1, 1)
const _mat4 = new THREE.Matrix4()
const _basis = new THREE.Matrix4()
const _yAxis = new THREE.Vector3(0, 1, 0)
const _zAxis = new THREE.Vector3(0, 0, 1)

// ── Per-family animation state (flat typed arrays → cache-friendly, no GC). ──
interface BirdState {
  // Each flock has a great-circle frame (two orthonormal basis vectors u,v) and
  // a current angle. Birds offset from the moving centroid with a smoothed lerp.
  flockU: Float32Array // FLOCK_COUNT * 3
  flockV: Float32Array // FLOCK_COUNT * 3
  flockAngle: Float32Array // FLOCK_COUNT
  flockRadius: Float32Array // FLOCK_COUNT (distance from planet center to centroid)
  // per-bird local offset target within its flock (drifts slowly)
  offset: Float32Array // BIRD_COUNT * 3 (live, smoothed)
  offTarget: Float32Array // BIRD_COUNT * 3 (wander goal)
  retarget: Float32Array // BIRD_COUNT (seconds until next offset retarget)
  phase: Float32Array // BIRD_COUNT (flap phase offset)
  bank: Float32Array // BIRD_COUNT (smoothed bank angle for turn lean)
}

interface FishState {
  dir: Float32Array // FISH_COUNT * 3 — unit anchor direction (over ocean)
  tan: Float32Array // FISH_COUNT * 3 — a surface tangent (hop travel dir)
  off: Float32Array // FISH_COUNT * 3 — tangential mill offset within the school
  timer: Float32Array // FISH_COUNT — counts down idle, then airborne
  airborne: Uint8Array // FISH_COUNT — 0 idle, 1 hopping
  hopT: Float32Array // FISH_COUNT — progress 0..1 through the current hop
  wait: Float32Array // FISH_COUNT — per-fish idle duration jitter [0..1)
  phase: Float32Array // FISH_COUNT — mill phase offset
}

interface PlaneState {
  u: Float32Array // NPC_PLANE_COUNT * 3 — great-circle basis u
  v: Float32Array // NPC_PLANE_COUNT * 3 — great-circle basis v
  angle: Float32Array // NPC_PLANE_COUNT
  radius: Float32Array // NPC_PLANE_COUNT (center→plane distance)
  respawn: Float32Array // NPC_PLANE_COUNT (>0 = hidden, counting down)
  trailT: Float32Array // NPC_PLANE_COUNT (seconds until next puff)
  // live world position handed to Paintball; updated in place each frame.
  targetPos: THREE.Vector3[]
}

interface BoatState {
  u: Float32Array // BOAT_COUNT * 3
  v: Float32Array // BOAT_COUNT * 3
  angle: Float32Array // BOAT_COUNT
  radius: Float32Array // BOAT_COUNT
  phase: Float32Array // BOAT_COUNT (bob phase)
  wakeT: Float32Array // BOAT_COUNT (seconds until next wake drop)
  wakeSide: Uint8Array // BOAT_COUNT (toggles L/R of the V)
}

interface CapyState {
  dir: Float32Array // CAPY_COUNT * 3 — anchor direction (land)
  surf: Float32Array // CAPY_COUNT — radius at the surface point
  baseYaw: Float32Array // CAPY_COUNT — seated facing
  phase: Float32Array // CAPY_COUNT (breathe phase)
  lookPhase: Float32Array // CAPY_COUNT (look-around phase)
}

// A generic pooled-particle ring (foam / vapour). Position + per-instance age.
interface PoolState {
  px: Float32Array // POOL
  py: Float32Array
  pz: Float32Array
  age: Float32Array // POOL — seconds elapsed (>= life ⇒ dead)
  life: Float32Array // POOL — total lifetime for this puff (0 ⇒ free slot)
  size: Float32Array // POOL — base size of this puff
  next: number // round-robin cursor
}

export function createNpcLifeSystem(): GameSystem {
  // Disposables captured at init.
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  const meshes: THREE.InstancedMesh[] = []

  // Instanced meshes (assigned in init, written in update).
  let birdMesh: THREE.InstancedMesh | null = null
  let fishMesh: THREE.InstancedMesh | null = null
  let planeMesh: THREE.InstancedMesh | null = null
  let boatMesh: THREE.InstancedMesh | null = null
  let capyMesh: THREE.InstancedMesh | null = null
  let splashMesh: THREE.InstancedMesh | null = null
  let wakeMesh: THREE.InstancedMesh | null = null
  let trailMesh: THREE.InstancedMesh | null = null

  // Animation state.
  let birds: BirdState | null = null
  let fish: FishState | null = null
  let planes: PlaneState | null = null
  let boats: BoatState | null = null
  let capys: CapyState | null = null
  let splash: PoolState | null = null
  let wake: PoolState | null = null
  let trail: PoolState | null = null

  let ctxRef: GameContext | null = null
  let radius = 100

  // ── small build helpers (init only) ─────────────────────────────────────

  const lambert = (color: THREE.Color, side?: THREE.Side): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true })
    if (side !== undefined) m.side = side
    materials.push(m)
    return m
  }

  /** Build an InstancedMesh from one geometry + material, registered for dispose. */
  const instanced = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    count: number,
    name: string,
  ): THREE.InstancedMesh => {
    geometries.push(geo)
    const im = new THREE.InstancedMesh(geo, mat, count)
    im.name = name
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    im.frustumCulled = false // these roam the whole globe
    im.castShadow = false
    im.receiveShadow = false
    // Whole-planet bounds so tooling never wrongly discards it.
    im.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), radius * 1.6)
    meshes.push(im)
    return im
  }

  const makePool = (count: number, size: number): PoolState => {
    const st: PoolState = {
      px: new Float32Array(count),
      py: new Float32Array(count),
      pz: new Float32Array(count),
      age: new Float32Array(count),
      life: new Float32Array(count),
      size: new Float32Array(count).fill(size),
      next: 0,
    }
    return st
  }

  // Spawn one particle in a pool at world point (x,y,z); auto-recycles oldest.
  const emit = (
    st: PoolState,
    x: number,
    y: number,
    z: number,
    life: number,
    size: number,
  ): void => {
    const n = st.px.length
    let i = st.next
    // prefer a free slot near the cursor; otherwise overwrite the cursor slot.
    for (let s = 0; s < n; s++) {
      const j = (st.next + s) % n
      if (st.life[j] === 0 || st.age[j]! >= st.life[j]!) {
        i = j
        break
      }
    }
    st.next = (i + 1) % n
    st.px[i] = x
    st.py[i] = y
    st.pz[i] = z
    st.age[i] = 0
    st.life[i] = life
    st.size[i] = size
    // The next updatePool() pass writes this slot's matrix.
  }

  // Uniform random unit direction into `out` using the system RNG.
  const randomDir = (rand: () => number, out: THREE.Vector3): THREE.Vector3 => {
    const z = rand() * 2 - 1
    const t = rand() * Math.PI * 2
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    out.set(r * Math.cos(t), z, r * Math.sin(t))
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0)
    else out.normalize()
    return out
  }

  // Find a unit direction whose surface tile is OCEAN (heightAt < 0), else any.
  const findOceanDir = (rand: () => number, out: THREE.Vector3): boolean => {
    for (let attempt = 0; attempt < 24; attempt++) {
      randomDir(rand, out)
      if (ctxRef!.planet.heightAt(out) < 0) return true
    }
    return false // fell through to last sampled dir (rare); caller may skip
  }

  // Find a unit direction whose surface tile is LAND (heightAt >= 0), else any.
  const findLandDir = (rand: () => number, out: THREE.Vector3): boolean => {
    for (let attempt = 0; attempt < 24; attempt++) {
      randomDir(rand, out)
      if (ctxRef!.planet.heightAt(out) >= 0) return true
    }
    return false
  }

  // Build an orthonormal great-circle frame (u,v) for a random plane through the
  // origin. A point at angle θ on the circle of radius R is R*(cosθ*u + sinθ*v).
  const makeGreatCircle = (
    rand: () => number,
    u3: Float32Array,
    v3: Float32Array,
    idx: number,
  ): void => {
    // random normal n, then u ⟂ n, v = n × u
    randomDir(rand, _dir) // reuse as normal
    // pick an arbitrary vector not parallel to _dir
    _up.set(0, 1, 0)
    if (Math.abs(_dir.dot(_up)) > 0.92) _up.set(1, 0, 0)
    _fwd.crossVectors(_dir, _up).normalize() // u
    _right.crossVectors(_dir, _fwd).normalize() // v
    const b = idx * 3
    u3[b] = _fwd.x
    u3[b + 1] = _fwd.y
    u3[b + 2] = _fwd.z
    v3[b] = _right.x
    v3[b + 1] = _right.y
    v3[b + 2] = _right.z
  }

  // Compose an instance matrix that places `geo +Y` along surface normal `nrm`,
  // points local +Z along `forward` (projected to be tangent), at world `p`.
  // Returns the basis-rotation quaternion in `_quat` and the basis in `_basis`.
  const composeOriented = (
    p: THREE.Vector3,
    nrm: THREE.Vector3,
    forward: THREE.Vector3,
    scale: number,
  ): THREE.Matrix4 => {
    _up.copy(nrm).normalize()
    // project forward onto the tangent plane of nrm
    _fwd.copy(forward).addScaledVector(_up, -forward.dot(_up))
    if (_fwd.lengthSq() < 1e-6) {
      // forward parallel to up — pick any tangent
      _fwd.set(1, 0, 0).addScaledVector(_up, -_up.x)
    }
    _fwd.normalize()
    _right.crossVectors(_up, _fwd).normalize()
    // basis columns: X=right, Y=up, Z=forward
    _basis.makeBasis(_right, _up, _fwd)
    _quat.setFromRotationMatrix(_basis)
    _scale.setScalar(scale)
    _mat4.compose(p, _quat, _scale)
    return _mat4
  }

  // Compose with explicit up + yaw spin only (used for surface critters).
  const composeUpright = (
    p: THREE.Vector3,
    nrm: THREE.Vector3,
    yaw: number,
    sx: number,
    sy: number,
    sz: number,
  ): THREE.Matrix4 => {
    _up.copy(nrm).normalize()
    _quat.setFromUnitVectors(_yAxis, _up)
    _spin.setFromAxisAngle(_yAxis, yaw)
    _quat.multiply(_spin)
    _scale.set(sx, sy, sz)
    _mat4.compose(p, _quat, _scale)
    return _mat4
  }

  // Park an instance far away + zero-scaled so it's invisible (no extra draw cost
  // beyond the instance slot we already pay for).
  const parkInstance = (im: THREE.InstancedMesh, i: number): void => {
    _scale.setScalar(0.0001)
    _quat.identity()
    _pos.set(0, 0, 0)
    _mat4.compose(_pos, _quat, _scale)
    im.setMatrixAt(i, _mat4)
  }

  return {
    name: 'npcLife',

    init(ctx: GameContext) {
      ctxRef = ctx
      radius = ctx.planet.radius
      const rand = ctx.rand

      // ============================================================
      // BIRDS — instanced low-poly gull (merged body + two wings via
      // vertex color), one InstancedMesh for all flocks.
      // ============================================================
      {
        const geo = buildBirdGeometry()
        const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
        materials.push(mat)
        birdMesh = instanced(geo, mat, BIRD_COUNT, 'npc.birds')
        ctx.scene.add(birdMesh)

        const st: BirdState = {
          flockU: new Float32Array(FLOCK_COUNT * 3),
          flockV: new Float32Array(FLOCK_COUNT * 3),
          flockAngle: new Float32Array(FLOCK_COUNT),
          flockRadius: new Float32Array(FLOCK_COUNT),
          offset: new Float32Array(BIRD_COUNT * 3),
          offTarget: new Float32Array(BIRD_COUNT * 3),
          retarget: new Float32Array(BIRD_COUNT),
          phase: new Float32Array(BIRD_COUNT),
          bank: new Float32Array(BIRD_COUNT),
        }
        for (let f = 0; f < FLOCK_COUNT; f++) {
          makeGreatCircle(rand, st.flockU, st.flockV, f)
          st.flockAngle[f] = rand() * Math.PI * 2
          st.flockRadius[f] = radius + BIRD_ALT_MIN + rand() * (BIRD_ALT_MAX - BIRD_ALT_MIN)
        }
        for (let i = 0; i < BIRD_COUNT; i++) {
          const b = i * 3
          // initial + target local offsets within the flock cloud
          st.offset[b] = (rand() * 2 - 1) * BIRD_SPREAD
          st.offset[b + 1] = (rand() * 2 - 1) * BIRD_SPREAD
          st.offset[b + 2] = (rand() * 2 - 1) * BIRD_SPREAD
          st.offTarget[b] = (rand() * 2 - 1) * BIRD_SPREAD
          st.offTarget[b + 1] = (rand() * 2 - 1) * BIRD_SPREAD
          st.offTarget[b + 2] = (rand() * 2 - 1) * BIRD_SPREAD
          st.retarget[i] = 1 + rand() * 3
          st.phase[i] = rand() * Math.PI * 2
        }
        birds = st
        birdMesh.instanceMatrix.needsUpdate = true
      }

      // ============================================================
      // FISH — instanced low-poly fish in small SCHOOLS that arc out
      // of the ocean and kick foam.
      // ============================================================
      {
        const geo = buildFishGeometry()
        const mat = lambert(FISH_BODY)
        fishMesh = instanced(geo, mat, FISH_COUNT, 'npc.fish')
        ctx.scene.add(fishMesh)

        const st: FishState = {
          dir: new Float32Array(FISH_COUNT * 3),
          tan: new Float32Array(FISH_COUNT * 3),
          off: new Float32Array(FISH_COUNT * 3),
          timer: new Float32Array(FISH_COUNT),
          airborne: new Uint8Array(FISH_COUNT),
          hopT: new Float32Array(FISH_COUNT),
          wait: new Float32Array(FISH_COUNT),
          phase: new Float32Array(FISH_COUNT),
        }
        for (let sIdx = 0; sIdx < SCHOOL_COUNT; sIdx++) {
          // One verified ocean anchor + tangent per school; fish share it.
          const ok = findOceanDir(rand, _dir)
          // school tangent frame (anchor up = _dir, tangents _fwd/_right)
          _up.copy(_dir)
          _fwd.set(0, 1, 0)
          if (Math.abs(_up.y) > 0.9) _fwd.set(1, 0, 0)
          _right.crossVectors(_up, _fwd).normalize() // tangent A (hop dir)
          _fwd.crossVectors(_up, _right).normalize() // tangent B (mill axis)
          for (let k = 0; k < FISH_PER_SCHOOL; k++) {
            const i = sIdx * FISH_PER_SCHOOL + k
            const b = i * 3
            if (!ok) {
              // No ocean tile found — park this fish permanently (defensive).
              st.dir[b] = 0
              st.dir[b + 1] = 1
              st.dir[b + 2] = 0
              st.timer[i] = Number.POSITIVE_INFINITY
              parkInstance(fishMesh, i)
              continue
            }
            st.dir[b] = _up.x
            st.dir[b + 1] = _up.y
            st.dir[b + 2] = _up.z
            st.tan[b] = _right.x
            st.tan[b + 1] = _right.y
            st.tan[b + 2] = _right.z
            // a small per-fish tangential offset so the school spreads out
            const oa = (rand() * 2 - 1) * FISH_SCHOOL_SPREAD
            const ob = (rand() * 2 - 1) * FISH_SCHOOL_SPREAD
            st.off[b] = _right.x * oa + _fwd.x * ob
            st.off[b + 1] = _right.y * oa + _fwd.y * ob
            st.off[b + 2] = _right.z * oa + _fwd.z * ob
            st.wait[i] = rand() // stable per-fish jitter reused on each splash-down
            st.timer[i] = FISH_IDLE_MIN + st.wait[i]! * (FISH_IDLE_MAX - FISH_IDLE_MIN)
            st.airborne[i] = 0
            st.hopT[i] = 0
            st.phase[i] = rand() * Math.PI * 2
          }
        }
        fish = st
        fishMesh.instanceMatrix.needsUpdate = true
      }

      // ============================================================
      // NPC PLANES — instanced mint craft on great circles. Positions
      // are published to (ctx as any).npcTargets for the Paintball system.
      // ============================================================
      {
        const geo = buildNpcPlaneGeometry()
        const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
        materials.push(mat)
        planeMesh = instanced(geo, mat, NPC_PLANE_COUNT, 'npc.planes')
        ctx.scene.add(planeMesh)

        const st: PlaneState = {
          u: new Float32Array(NPC_PLANE_COUNT * 3),
          v: new Float32Array(NPC_PLANE_COUNT * 3),
          angle: new Float32Array(NPC_PLANE_COUNT),
          radius: new Float32Array(NPC_PLANE_COUNT),
          respawn: new Float32Array(NPC_PLANE_COUNT),
          trailT: new Float32Array(NPC_PLANE_COUNT),
          targetPos: [],
        }
        const targets: Array<{
          position: THREE.Vector3
          radius: number
          alive: boolean
          onHit: (p?: any) => void
        }> = []
        for (let i = 0; i < NPC_PLANE_COUNT; i++) {
          makeGreatCircle(rand, st.u, st.v, i)
          st.angle[i] = rand() * Math.PI * 2
          st.radius[i] = radius + PLANE_ALT
          st.respawn[i] = 0
          st.trailT[i] = rand() * PLANE_TRAIL_SPACING
          const livePos = new THREE.Vector3()
          st.targetPos.push(livePos)
          // Capture index for the onHit closure (init-only allocation; fine).
          const idx = i
          targets.push({
            position: livePos,
            radius: PLANE_HIT_RADIUS,
            alive: true,
            onHit: () => onPlaneHit(idx),
          })
        }
        planes = st
        // Publish to the shared context for Paintball to consume.
        ;(ctx as any).npcTargets = targets
        planeMesh.instanceMatrix.needsUpdate = true
      }

      // ============================================================
      // BOATS — instanced wooden boats bobbing/sailing on the sea.
      // ============================================================
      {
        const geo = buildBoatGeometry()
        const mat = new THREE.MeshLambertMaterial({
          vertexColors: true,
          flatShading: true,
          side: THREE.DoubleSide, // the sail is a thin sheet
        })
        materials.push(mat)
        boatMesh = instanced(geo, mat, BOAT_COUNT, 'npc.boats')
        ctx.scene.add(boatMesh)

        const st: BoatState = {
          u: new Float32Array(BOAT_COUNT * 3),
          v: new Float32Array(BOAT_COUNT * 3),
          angle: new Float32Array(BOAT_COUNT),
          radius: new Float32Array(BOAT_COUNT),
          phase: new Float32Array(BOAT_COUNT),
          wakeT: new Float32Array(BOAT_COUNT),
          wakeSide: new Uint8Array(BOAT_COUNT),
        }
        for (let i = 0; i < BOAT_COUNT; i++) {
          // Find an ocean anchor, then build a great circle THROUGH that point so
          // the boat sails along the water (good enough — sea covers most arcs).
          const ok = findOceanDir(rand, _dir)
          if (!ok) {
            st.radius[i] = -1 // flag: parked
            parkInstance(boatMesh, i)
            continue
          }
          // u = anchor dir; v = a tangent. Boat starts at angle 0 on this circle.
          _up.copy(_dir)
          _fwd.set(0, 1, 0)
          if (Math.abs(_up.y) > 0.9) _fwd.set(1, 0, 0)
          _right.crossVectors(_up, _fwd).normalize()
          const b = i * 3
          st.u[b] = _up.x
          st.u[b + 1] = _up.y
          st.u[b + 2] = _up.z
          st.v[b] = _right.x
          st.v[b + 1] = _right.y
          st.v[b + 2] = _right.z
          st.angle[i] = 0
          st.radius[i] = radius - 0.4 + BOAT_ALT // sit on/just above water shell
          st.phase[i] = rand() * Math.PI * 2
          st.wakeT[i] = rand() * BOAT_WAKE_SPACING
        }
        boats = st
        boatMesh.instanceMatrix.needsUpdate = true
      }

      // ============================================================
      // CAPYBARAS — instanced, sitting on land, breathing + looking around.
      // ============================================================
      {
        const geo = buildCapyGeometry()
        const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
        materials.push(mat)
        capyMesh = instanced(geo, mat, CAPY_COUNT, 'npc.capys')
        ctx.scene.add(capyMesh)

        const st: CapyState = {
          dir: new Float32Array(CAPY_COUNT * 3),
          surf: new Float32Array(CAPY_COUNT),
          baseYaw: new Float32Array(CAPY_COUNT),
          phase: new Float32Array(CAPY_COUNT),
          lookPhase: new Float32Array(CAPY_COUNT),
        }
        for (let i = 0; i < CAPY_COUNT; i++) {
          const b = i * 3
          const ok = findLandDir(rand, _dir)
          st.dir[b] = _dir.x
          st.dir[b + 1] = _dir.y
          st.dir[b + 2] = _dir.z
          // surface radius at this tile (surfacePoint allocates — init only).
          const sp = ctx.planet.surfacePoint(_dir, 0)
          st.surf[i] = ok ? sp.length() : radius
          st.baseYaw[i] = rand() * Math.PI * 2
          st.phase[i] = rand() * Math.PI * 2
          st.lookPhase[i] = rand() * Math.PI * 2
          // seat immediately so it never flashes at the origin
          _pos.copy(_dir).multiplyScalar(st.surf[i] + 0.4)
          capyMesh.setMatrixAt(i, composeUpright(_pos, _dir, st.baseYaw[i]!, 1, 1, 1))
        }
        capys = st
        capyMesh.instanceMatrix.needsUpdate = true
      }

      // ============================================================
      // PARTICLE FAMILIES — foam splashes, boat wakes, plane trails.
      // Each is one instanced billboard-ish quad pool, fully parked at init.
      // ============================================================
      {
        const splashGeo = new THREE.CircleGeometry(0.5, 6)
        const splashMat = new THREE.MeshBasicMaterial({
          color: FOAM,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
        materials.push(splashMat)
        splashMesh = instanced(splashGeo, splashMat, SPLASH_POOL, 'npc.splash')
        ctx.scene.add(splashMesh)
        splash = makePool(SPLASH_POOL, 0.9)
        for (let i = 0; i < SPLASH_POOL; i++) parkInstance(splashMesh, i)
        splashMesh.instanceMatrix.needsUpdate = true

        const wakeGeo = new THREE.CircleGeometry(0.5, 6)
        const wakeMat = new THREE.MeshBasicMaterial({
          color: FOAM,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
        materials.push(wakeMat)
        wakeMesh = instanced(wakeGeo, wakeMat, WAKE_POOL, 'npc.wake')
        ctx.scene.add(wakeMesh)
        wake = makePool(WAKE_POOL, 1.0)
        for (let i = 0; i < WAKE_POOL; i++) parkInstance(wakeMesh, i)
        wakeMesh.instanceMatrix.needsUpdate = true

        const trailGeo = new THREE.CircleGeometry(0.5, 6)
        const trailMat = new THREE.MeshBasicMaterial({
          color: VAPOUR,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
        materials.push(trailMat)
        trailMesh = instanced(trailGeo, trailMat, TRAIL_POOL, 'npc.trail')
        ctx.scene.add(trailMesh)
        trail = makePool(TRAIL_POOL, 1.2)
        for (let i = 0; i < TRAIL_POOL; i++) parkInstance(trailMesh, i)
        trailMesh.instanceMatrix.needsUpdate = true
      }
    },

    update(dt: number, ctx: GameContext) {
      // Clamp dt (resume-from-background safety), matching the flight model.
      if (dt > 1 / 30) dt = 1 / 30
      const t = ctx.elapsed()

      updateBirds(dt, t)
      updateFish(dt, t)
      updatePlanes(dt)
      updateBoats(dt, t)
      updateCapys(t)
      // Particle pools billboard toward the camera; integrate after emitters ran.
      updatePool(splash, splashMesh, dt, ctx.camera)
      updatePool(wake, wakeMesh, dt, ctx.camera)
      updatePool(trail, trailMesh, dt, ctx.camera)
    },

    dispose() {
      // Clear the published targets so Paintball stops referencing freed data.
      if (ctxRef) {
        const targets = (ctxRef as any).npcTargets
        if (Array.isArray(targets)) (ctxRef as any).npcTargets = []
      }
      for (const m of meshes) {
        m.parent?.remove(m)
        m.dispose()
      }
      meshes.length = 0
      for (const g of geometries) g.dispose()
      geometries.length = 0
      for (const mt of materials) mt.dispose()
      materials.length = 0
      birdMesh = fishMesh = planeMesh = boatMesh = capyMesh = null
      splashMesh = wakeMesh = trailMesh = null
      birds = fish = planes = boats = capys = null
      splash = wake = trail = null
      ctxRef = null
    },
  }

  // ── per-family update routines (zero allocation; use module scratch) ──────

  function updateBirds(dt: number, t: number): void {
    if (!birds || !birdMesh) return
    const st = birds
    const cohesion = damp(1.5, dt)
    const bankEase = damp(3.0, dt)
    for (let f = 0; f < FLOCK_COUNT; f++) {
      st.flockAngle[f]! += BIRD_ANGULAR_SPEED * dt
      const a = st.flockAngle[f]!
      const R = st.flockRadius[f]!
      const ub = f * 3
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      // centroid = R*(cos a * U + sin a * V)
      _centroid.set(
        R * (ca * st.flockU[ub]! + sa * st.flockV[ub]!),
        R * (ca * st.flockU[ub + 1]! + sa * st.flockV[ub + 1]!),
        R * (ca * st.flockU[ub + 2]! + sa * st.flockV[ub + 2]!),
      )
      // flock travel direction (derivative of centroid) → birds face this way.
      _fwd.set(
        -sa * st.flockU[ub]! + ca * st.flockV[ub]!,
        -sa * st.flockU[ub + 1]! + ca * st.flockV[ub + 1]!,
        -sa * st.flockU[ub + 2]! + ca * st.flockV[ub + 2]!,
      )
      // surface normal at the centroid (radial out)
      _up.copy(_centroid).normalize()
      const base = f * BIRDS_PER_FLOCK

      for (let k = 0; k < BIRDS_PER_FLOCK; k++) {
        const i = base + k
        const b = i * 3
        // retarget the wander offset occasionally (cheap pseudo-boids drift)
        st.retarget[i]! -= dt
        if (st.retarget[i]! <= 0) {
          st.retarget[i] = 1.5 + (st.phase[i]! % 3)
          // reflect the target around so it stays bounded without rand() here:
          st.offTarget[b] = -st.offset[b]! * 0.8 + Math.sin(t + st.phase[i]!) * BIRD_SPREAD * 0.5
          st.offTarget[b + 1] =
            -st.offset[b + 1]! * 0.8 + Math.cos(t * 1.3 + st.phase[i]!) * BIRD_SPREAD * 0.4
          st.offTarget[b + 2] =
            -st.offset[b + 2]! * 0.8 + Math.sin(t * 0.7 + st.phase[i]!) * BIRD_SPREAD * 0.5
        }

        // SEPARATION — push away from nearby flockmates (cheap O(n²) over a tiny
        // flock). Accumulate in _sep using only offset deltas (local space).
        _sep.set(0, 0, 0)
        for (let m = 0; m < BIRDS_PER_FLOCK; m++) {
          if (m === k) continue
          const ob = (base + m) * 3
          const dx = st.offset[b]! - st.offset[ob]!
          const dy = st.offset[b + 1]! - st.offset[ob + 1]!
          const dz = st.offset[b + 2]! - st.offset[ob + 2]!
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < BIRD_SEPARATION * BIRD_SEPARATION && d2 > 1e-4) {
            const inv = 1 / Math.sqrt(d2)
            _sep.x += dx * inv
            _sep.y += dy * inv
            _sep.z += dz * inv
          }
        }

        // ease offset toward target (cohesion) then nudge by separation.
        st.offset[b]! += (st.offTarget[b]! - st.offset[b]!) * cohesion + _sep.x * dt * 1.4
        st.offset[b + 1]! += (st.offTarget[b + 1]! - st.offset[b + 1]!) * cohesion + _sep.y * dt * 1.4
        st.offset[b + 2]! += (st.offTarget[b + 2]! - st.offset[b + 2]!) * cohesion + _sep.z * dt * 1.4

        // world position = centroid + offset (offset is in world space; fine for
        // a small cloud — keeps it cheap and the spread reads naturally).
        _pos.set(
          _centroid.x + st.offset[b]!,
          _centroid.y + st.offset[b + 1]!,
          _centroid.z + st.offset[b + 2]!,
        )

        // BANK — lean into the turn. Sample lateral component of the wander goal
        // relative to forward, smoothed, so the whole flock leans as one.
        const lateral = st.offTarget[b]! * _fwd.x + st.offTarget[b + 2]! * _fwd.z
        const wantBank = THREE.MathUtils.clamp(-lateral * 0.04, -0.4, 0.4)
        st.bank[i]! += (wantBank - st.bank[i]!) * bankEase

        // wing flap (gentle, asymmetric on up vs down for a flap feel).
        const flap = Math.sin(t * BIRD_FLAP_HZ + st.phase[i]!)
        // orient: +Z along flock forward, +Y radial out, then post-roll for the
        // flap dihedral + the smoothed bank lean about local +Z.
        composeOriented(_pos, _up, _fwd, 1)
        _spin.setFromAxisAngle(_zAxis, flap * 0.35 + st.bank[i]!)
        _quat.setFromRotationMatrix(_basis).multiply(_spin)
        _scale.set(1, 0.85 + Math.abs(flap) * 0.25, 1)
        _mat4.compose(_pos, _quat, _scale)
        birdMesh.setMatrixAt(i, _mat4)
      }
    }
    birdMesh.instanceMatrix.needsUpdate = true
  }

  function updateFish(dt: number, t: number): void {
    if (!fish || !fishMesh) return
    const st = fish
    const surfR = radius - 0.4 // water shell radius (heightAt over ocean ≈ -inset)
    let dirty = false
    for (let i = 0; i < FISH_COUNT; i++) {
      const b = i * 3
      if (!isFinite(st.timer[i]!) && st.airborne[i] === 0) continue // permanently parked
      dirty = true
      _dir.set(st.dir[b]!, st.dir[b + 1]!, st.dir[b + 2]!)

      if (st.airborne[i] === 0) {
        // idle just under the water; mill within the school; tick toward the hop.
        st.timer[i]! -= dt
        // base anchor + school offset + a tiny tangential mill wobble.
        _fwd.set(st.tan[b]!, st.tan[b + 1]!, st.tan[b + 2]!)
        const mill = Math.sin(t * 0.8 + st.phase[i]!) // gentle idle drift
        _pos
          .copy(_dir)
          .multiplyScalar(surfR - FISH_ALT)
          .add(_sep.set(st.off[b]!, st.off[b + 1]!, st.off[b + 2]!))
          .addScaledVector(_fwd, mill * 0.4)
        composeOriented(_pos, _dir, _fwd, 0.6)
        fishMesh.setMatrixAt(i, _mat4)
        if (st.timer[i]! <= 0) {
          st.airborne[i] = 1
          st.hopT[i] = 0
          // FOAM kick on take-off, at the launch point on the shell.
          _pos.copy(_dir).multiplyScalar(surfR).add(_sep.set(st.off[b]!, st.off[b + 1]!, st.off[b + 2]!))
          kickFoam(_pos, 0.7)
        }
      } else {
        // ballistic arc out of the water along the tangent, nose-leading.
        st.hopT[i]! += dt / FISH_HOP_TIME
        const p = st.hopT[i]!
        _fwd.set(st.tan[b]!, st.tan[b + 1]!, st.tan[b + 2]!)
        if (p >= 1) {
          // splash down → back to idle with a fresh wait (deterministic jitter
          // advanced per hop so fish don't fall into lockstep over time).
          st.airborne[i] = 0
          st.wait[i] = (st.wait[i]! * 1.6180339 + 0.37) % 1 // cheap LCG-ish churn
          st.timer[i] = FISH_IDLE_MIN + st.wait[i]! * (FISH_IDLE_MAX - FISH_IDLE_MIN)
          // FOAM splash at the landing point (end of the lateral travel).
          _pos
            .copy(_dir)
            .multiplyScalar(surfR)
            .add(_sep.set(st.off[b]!, st.off[b + 1]!, st.off[b + 2]!))
            .addScaledVector(_fwd, 2.0)
          kickFoam(_pos, 1.0)
          // park submerged this frame
          _pos.copy(_dir).multiplyScalar(surfR - FISH_ALT).add(_sep.set(st.off[b]!, st.off[b + 1]!, st.off[b + 2]!))
          composeOriented(_pos, _dir, _fwd, 0.6)
          fishMesh.setMatrixAt(i, _mat4)
          continue
        }
        // height follows a parabola: peaks at p=0.5
        const h = FISH_HOP_HEIGHT * 4 * p * (1 - p)
        // slight lateral travel along the tangent during the hop
        const travel = (p - 0.5) * 4.0
        // base point on the shell + school offset + lateral drift, lifted normal.
        _pos
          .copy(_dir)
          .multiplyScalar(surfR)
          .add(_sep.set(st.off[b]!, st.off[b + 1]!, st.off[b + 2]!))
          .addScaledVector(_fwd, travel)
          .addScaledVector(_dir, h)
        // pitch the fish so its nose follows the arc: tilt up on rise, down on
        // fall. Rebuild forward to include vertical component.
        const vy = (1 - 2 * p) * FISH_HOP_HEIGHT * 2 // d(h)/dp sign → up then down
        _right.copy(_fwd).multiplyScalar(4.0).addScaledVector(_dir, vy)
        if (_right.lengthSq() < 1e-6) _right.copy(_fwd)
        _right.normalize()
        composeOriented(_pos, _dir, _right, 0.6 + 0.1 * Math.sin(p * Math.PI))
        fishMesh.setMatrixAt(i, _mat4)
      }
    }
    if (dirty) fishMesh.instanceMatrix.needsUpdate = true
  }

  // Emit a small ring of foam droplets around world point `p`.
  function kickFoam(p: THREE.Vector3, strength: number): void {
    if (!splash || !splashMesh) return
    const n = 3 + Math.round(strength * 2)
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2
      const r = 0.6 + strength * 0.8
      // jitter around the point in a flat ring (we don't need surface-perfect)
      const x = p.x + Math.cos(a) * r
      const z = p.z + Math.sin(a) * r
      emit(splash, x, p.y + 0.3, z, SPLASH_LIFE, 0.7 + strength * 0.4)
    }
  }

  function updatePlanes(dt: number): void {
    if (!planes || !planeMesh) return
    const st = planes
    for (let i = 0; i < NPC_PLANE_COUNT; i++) {
      const b = i * 3
      const target = (ctxRef as any)?.npcTargets?.[i] as
        | { position: THREE.Vector3; alive: boolean }
        | undefined

      if (st.respawn[i]! > 0) {
        // hidden, counting down to reappear elsewhere.
        st.respawn[i]! -= dt
        if (st.respawn[i]! <= 0) {
          // respawn on a fresh great circle (rand() is fine — not per-frame hot
          // path; only fires on a respawn event).
          makeGreatCircle(ctxRef!.rand, st.u, st.v, i)
          st.angle[i] = ctxRef!.rand() * Math.PI * 2
          if (target) target.alive = true
        } else {
          continue // stay parked
        }
      }

      st.angle[i]! += PLANE_ANGULAR_SPEED * dt
      const a = st.angle[i]!
      const R = st.radius[i]!
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      _pos.set(
        R * (ca * st.u[b]! + sa * st.v[b]!),
        R * (ca * st.u[b + 1]! + sa * st.v[b + 1]!),
        R * (ca * st.u[b + 2]! + sa * st.v[b + 2]!),
      )
      // travel direction (derivative) for nose orientation
      _fwd.set(
        -sa * st.u[b]! + ca * st.v[b]!,
        -sa * st.u[b + 1]! + ca * st.v[b + 1]!,
        -sa * st.u[b + 2]! + ca * st.v[b + 2]!,
      )
      _up.copy(_pos).normalize()
      composeOriented(_pos, _up, _fwd, 1)
      planeMesh.setMatrixAt(i, _mat4)

      // publish live world position for Paintball collision.
      st.targetPos[i]!.copy(_pos)

      // VAPOUR TRAIL — drop a puff just behind the tail on a fixed cadence.
      st.trailT[i]! -= dt
      if (st.trailT[i]! <= 0 && trail && trailMesh) {
        st.trailT[i] = PLANE_TRAIL_SPACING
        // tail point ≈ pos − forward*1.6 (NPC plane is ~2.2 long * scale)
        _sep.copy(_pos).addScaledVector(_fwd, -1.8)
        emit(trail, _sep.x, _sep.y, _sep.z, PLANE_TRAIL_LIFE, 1.2)
      }
    }
    planeMesh.instanceMatrix.needsUpdate = true
  }

  // Called from a target's onHit closure when a paintball connects.
  function onPlaneHit(i: number): void {
    if (!planes || !planeMesh || !ctxRef) return
    const st = planes
    if (st.respawn[i]! > 0) return // already down
    st.respawn[i] = PLANE_RESPAWN_DELAY
    const target = (ctxRef as any).npcTargets?.[i] as { alive: boolean } | undefined
    if (target) target.alive = false
    // POOF — a burst of vapour where it was tagged.
    if (trail && trailMesh) {
      const p = st.targetPos[i]!
      for (let j = 0; j < 6; j++) {
        const a = (j / 6) * Math.PI * 2
        emit(trail, p.x + Math.cos(a) * 1.2, p.y, p.z + Math.sin(a) * 1.2, 0.9, 2.0)
      }
    }
    parkInstance(planeMesh, i)
    planeMesh.instanceMatrix.needsUpdate = true
    ctxRef.audio.play('hit', { volume: 0.5 })
    ctxRef.hud.toast('Tagged an NPC craft!', 1400)
  }

  function updateBoats(dt: number, t: number): void {
    if (!boats || !boatMesh) return
    const st = boats
    for (let i = 0; i < BOAT_COUNT; i++) {
      if (st.radius[i]! < 0) continue // parked (no ocean tile found)
      const b = i * 3
      st.angle[i]! += BOAT_ANGULAR_SPEED * dt
      const a = st.angle[i]!
      const R = st.radius[i]!
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      _pos.set(
        R * (ca * st.u[b]! + sa * st.v[b]!),
        R * (ca * st.u[b + 1]! + sa * st.v[b + 1]!),
        R * (ca * st.u[b + 2]! + sa * st.v[b + 2]!),
      )
      // sailing direction (derivative) → bow faces travel
      _fwd.set(
        -sa * st.u[b]! + ca * st.v[b]!,
        -sa * st.u[b + 1]! + ca * st.v[b + 1]!,
        -sa * st.u[b + 2]! + ca * st.v[b + 2]!,
      )
      _up.copy(_pos).normalize()
      // gentle bob: lift a touch and rock about the travel axis.
      const bob = Math.sin(t * BOAT_BOB_HZ * Math.PI * 2 + st.phase[i]!)
      _pos.addScaledVector(_up, bob * 0.25)
      composeOriented(_pos, _up, _fwd, 1)
      // post-roll for the rock (small)
      _quat.setFromRotationMatrix(_basis)
      _spin.setFromAxisAngle(_zAxis, bob * 0.12)
      _quat.multiply(_spin)
      _scale.setScalar(1)
      _mat4.compose(_pos, _quat, _scale)
      boatMesh.setMatrixAt(i, _mat4)

      // V-WAKE — drop foam quads alternating left/right behind the stern, so the
      // recycled trail reads as a spreading V. `_right` is the boat's side axis.
      st.wakeT[i]! -= dt
      if (st.wakeT[i]! <= 0 && wake && wakeMesh) {
        st.wakeT[i] = BOAT_WAKE_SPACING
        const side = st.wakeSide[i] === 0 ? 1 : -1
        st.wakeSide[i] = st.wakeSide[i] === 0 ? 1 : 0
        // stern point = pos − forward*1.4, splayed sideways by the side axis.
        _right.crossVectors(_up, _fwd).normalize()
        _sep
          .copy(_pos)
          .addScaledVector(_fwd, -1.4)
          .addScaledVector(_right, side * 0.5)
          .addScaledVector(_up, -bob * 0.25) // sit back on the water surface
        emit(wake, _sep.x, _sep.y, _sep.z, BOAT_WAKE_LIFE, 1.0)
      }
    }
    boatMesh.instanceMatrix.needsUpdate = true
  }

  function updateCapys(t: number): void {
    if (!capys || !capyMesh) return
    const st = capys
    for (let i = 0; i < CAPY_COUNT; i++) {
      const b = i * 3
      _dir.set(st.dir[b]!, st.dir[b + 1]!, st.dir[b + 2]!)
      _pos.copy(_dir).multiplyScalar(st.surf[i]! + 0.4)
      // slow breathing scale pulse on Y (and a hair on Z).
      const breathe = Math.sin(t * CAPY_BREATHE_HZ * Math.PI * 2 + st.phase[i]!)
      const sy = 1 + breathe * 0.05
      const sz = 1 + breathe * 0.03
      // idle LOOK-AROUND: lazily sway the seated yaw with two slow sines so it
      // peers left, settles, peers right — never a constant spin.
      const look =
        Math.sin(t * CAPY_LOOK_HZ * Math.PI * 2 + st.lookPhase[i]!) * 0.6 +
        Math.sin(t * CAPY_LOOK_HZ * 0.37 * Math.PI * 2 + st.lookPhase[i]!) * 0.25
      capyMesh.setMatrixAt(i, composeUpright(_pos, _dir, st.baseYaw[i]! + look, 1, sy, sz))
    }
    capyMesh.instanceMatrix.needsUpdate = true
  }

  // Integrate a particle pool: grow + fade each live puff, billboard it to the
  // camera, park dead ones. One needsUpdate per pool per frame.
  function updatePool(
    st: PoolState | null,
    im: THREE.InstancedMesh | null,
    dt: number,
    camera: THREE.Camera,
  ): void {
    if (!st || !im) return
    const n = st.px.length
    let dirty = false
    for (let i = 0; i < n; i++) {
      const life = st.life[i]!
      if (life === 0) continue
      let age = st.age[i]!
      if (age >= life) continue // already dead & parked
      age += dt
      st.age[i] = age
      dirty = true
      if (age >= life) {
        st.life[i] = 0
        parkInstance(im, i)
        continue
      }
      const u = age / life // 0..1
      // foam/vapour expands then thins out. Ease scale up fast, fade via shrink
      // near the end (single shared material opacity, so we shrink to fade out).
      const grow = 0.5 + u * 1.1
      const fade = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1
      const s = st.size[i]! * grow * fade
      _pos.set(st.px[i]!, st.py[i]!, st.pz[i]!)
      // billboard: face the camera (flat quad, +Z toward camera).
      _quat.copy(camera.quaternion)
      _scale.set(s, s, s)
      _mat4.compose(_pos, _quat, _scale)
      im.setMatrixAt(i, _mat4)
    }
    if (dirty) im.instanceMatrix.needsUpdate = true
  }
}

// ── Geometry builders (init-time only; each returns ONE merged BufferGeometry
//    with a per-vertex color attribute where multiple tints are needed). ──────

/** A small gull: a slim body (octahedron) + two flat triangle wings. */
function buildBirdGeometry(): THREE.BufferGeometry {
  // body: stretched octahedron along Z (nose +Z)
  const body = new THREE.OctahedronGeometry(0.5, 0)
  body.scale(0.5, 0.4, 1.3)
  paint(body, BIRD_BODY)

  // wings: two thin boxes angled out from the shoulders (a shallow V).
  const wingL = new THREE.BoxGeometry(1.4, 0.06, 0.6)
  wingL.translate(-0.8, 0.05, 0)
  wingL.rotateZ(0.18)
  paint(wingL, BIRD_WING)

  const wingR = new THREE.BoxGeometry(1.4, 0.06, 0.6)
  wingR.translate(0.8, 0.05, 0)
  wingR.rotateZ(-0.18)
  paint(wingR, BIRD_WING)

  // a tiny tail
  const tail = new THREE.ConeGeometry(0.18, 0.5, 4)
  tail.rotateX(-Math.PI / 2)
  tail.translate(0, 0, -0.8)
  paint(tail, BIRD_BODY)

  return mergeOrFallback([body, wingL, wingR, tail], 0.6)
}

/** A pastel fish: teardrop body (cone) + a tail fin. Nose along +Z. */
function buildFishGeometry(): THREE.BufferGeometry {
  const body = new THREE.ConeGeometry(0.55, 1.6, 7)
  body.rotateX(Math.PI / 2) // nose +Z
  body.scale(1, 0.7, 1) // slim vertically
  paint(body, FISH_BODY)

  const tail = new THREE.ConeGeometry(0.5, 0.7, 4)
  tail.rotateX(-Math.PI / 2)
  tail.scale(1, 0.6, 1)
  tail.translate(0, 0, -0.95)
  paint(tail, FISH_BODY)

  return mergeOrFallback([body, tail], 0.5)
}

/** A wandering NPC craft: mint fuselage, cream wings + tail. Nose +Z. */
function buildNpcPlaneGeometry(): THREE.BufferGeometry {
  const fuse = new THREE.BoxGeometry(0.5, 0.5, 2.2)
  paint(fuse, PLANE_BODY)

  const nose = new THREE.ConeGeometry(0.3, 0.8, 8)
  nose.rotateX(Math.PI / 2)
  nose.translate(0, 0, 1.45)
  paint(nose, PLANE_BODY)

  const wing = new THREE.BoxGeometry(3.4, 0.1, 0.8)
  wing.translate(0, 0.05, 0.1)
  paint(wing, PLANE_WING)

  const tailH = new THREE.BoxGeometry(1.2, 0.08, 0.5)
  tailH.translate(0, 0.05, -1.0)
  paint(tailH, PLANE_WING)

  const fin = new THREE.BoxGeometry(0.08, 0.55, 0.5)
  fin.translate(0, 0.35, -1.0)
  paint(fin, PLANE_WING)

  return mergeOrFallback([fuse, nose, wing, tailH, fin], 1.0)
}

/** A little boat: woody hull (tapered box-ish) + a cream triangular sail. */
function buildBoatGeometry(): THREE.BufferGeometry {
  // hull: a box with a pointed bow (use a cone half-merged would be heavy; a
  // simple scaled box + a wedge nose reads fine at distance).
  const hull = new THREE.BoxGeometry(1.0, 0.5, 2.4)
  hull.translate(0, 0.0, 0)
  paint(hull, BOAT_HULL)

  const bow = new THREE.ConeGeometry(0.55, 1.0, 4)
  bow.rotateX(Math.PI / 2)
  bow.scale(1, 0.9, 1)
  bow.translate(0, 0, 1.5)
  paint(bow, BOAT_HULL)

  // mast
  const mast = new THREE.CylinderGeometry(0.06, 0.06, 1.8, 5)
  mast.translate(0, 1.0, -0.1)
  paint(mast, BOAT_HULL)

  // sail: a thin upright sheet (single-sided geo; material is DoubleSide)
  const sail = new THREE.PlaneGeometry(1.2, 1.4)
  sail.translate(0, 1.0, 0.0)
  paint(sail, BOAT_SAIL)

  return mergeOrFallback([hull, bow, mast, sail], 1.0)
}

/** A capybara: a chunky rounded body + blocky head + tiny ears. */
function buildCapyGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1.2, 0.9, 1.8)
  body.translate(0, 0.45, 0)
  // round the body a touch by scaling an icosahedron instead would lose the
  // cozy blocky look; keep the box but soften with vertex normals from merge.
  paint(body, CAPY_FUR)

  const head = new THREE.BoxGeometry(0.8, 0.7, 0.7)
  head.translate(0, 0.7, 1.05)
  paint(head, CAPY_FUR)

  const snout = new THREE.BoxGeometry(0.5, 0.4, 0.35)
  snout.translate(0, 0.6, 1.45)
  paint(snout, CAPY_SNOUT)

  const earL = new THREE.BoxGeometry(0.18, 0.18, 0.12)
  earL.translate(-0.25, 1.05, 0.95)
  paint(earL, CAPY_FUR)

  const earR = new THREE.BoxGeometry(0.18, 0.18, 0.12)
  earR.translate(0.25, 1.05, 0.95)
  paint(earR, CAPY_FUR)

  return mergeOrFallback([body, head, snout, earL, earR], 1.2)
}

// ── geometry utilities ────────────────────────────────────────────────────

/** Write a flat per-vertex color attribute so one material shows many tints. */
function paint(geo: THREE.BufferGeometry, color: THREE.Color): void {
  const count = geo.attributes.position.count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

/**
 * Merge several colored part-geometries into one non-indexed BufferGeometry with
 * recomputed flat normals. Avoids importing BufferGeometryUtils to keep deps to
 * just 'three' + the contract: we hand-concatenate position + color attributes.
 * (All parts must carry a 'color' attribute via paint(); we drop other attrs.)
 *
 * `scale` uniformly scales the merged result so each critter sits at a sensible
 * world size relative to the planet.
 */
function mergeOrFallback(parts: THREE.BufferGeometry[], scale: number): THREE.BufferGeometry {
  // First convert each part to a non-indexed copy (flat triangles), tallying the
  // total vertex count. We build a fresh list so we never mutate `parts` mid-loop.
  const nonIndexed: THREE.BufferGeometry[] = []
  let total = 0
  for (const p of parts) {
    const np = p.toNonIndexed() // returns a NEW geometry (copies attributes)
    nonIndexed.push(np)
    total += np.attributes.position.count
    p.dispose() // the original part is no longer needed
  }

  const positions = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)
  let off = 0
  for (const p of nonIndexed) {
    const pos = p.attributes.position as THREE.BufferAttribute
    const col = p.attributes.color as THREE.BufferAttribute | undefined
    const n = pos.count
    for (let i = 0; i < n; i++) {
      const o = (off + i) * 3
      positions[o] = pos.getX(i)
      positions[o + 1] = pos.getY(i)
      positions[o + 2] = pos.getZ(i)
      if (col) {
        colors[o] = col.getX(i)
        colors[o + 1] = col.getY(i)
        colors[o + 2] = col.getZ(i)
      } else {
        colors[o] = 1
        colors[o + 1] = 1
        colors[o + 2] = 1
      }
    }
    off += n
    p.dispose()
  }

  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  if (scale !== 1) merged.scale(scale, scale, scale)
  merged.computeVertexNormals() // crisp flat-shaded facets (also fills normals)
  merged.computeBoundingSphere()
  return merged
}
