import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { WORLD_SCALE } from '../world/WorldConfig'
import { GlowParticles } from '../art/particles'

/**
 * Combat — the primary projectile weapon. Hold **Space** (`ctx.input.firing`)
 * to auto-fire a stream of glowing bolts out the plane's nose (local +Z).
 *
 * Each bolt is captured AT FIRE TIME with a frozen forward direction, so it
 * travels a dead-straight line (no homing, no gravity) faster than the plane.
 * Bolts read as streaks: a low-poly elongated octahedron, self-lit with an
 * HDR-bright colour that crests the UnrealBloomPass threshold (0.9) so it
 * blooms, oriented to its velocity via a +Z→dir quaternion.
 *
 * Perf (mobile-first, zero GC churn):
 *   - ONE pooled InstancedMesh for all bolts (single draw call, POOL_SIZE)
 *   - SoA parallel typed arrays for pool state (pos / vel / life / active)
 *   - round-robin spawn; OLDEST-active recycle when the pool is saturated
 *   - module-scoped temps + squared-distance hit tests → ZERO update() alloc
 *   - instanceMatrix.needsUpdate flipped only when something actually moved
 *
 * NPC target duck-type (the array may be absent; the system tolerates it):
 *   interface NpcTarget {
 *     pos: THREE.Vector3        // world position (required for the hit test)
 *     hitRadius?: number        // hit radius; default DEFAULT_HIT_RADIUS
 *     onHit?: () => void        // called on impact
 *   }
 */

// ----- tuning (authored lengths scale with the world) -----------------------

const POOL_SIZE = 48 // simultaneous bolts in flight (fixed pool)
const FIRE_INTERVAL = 0.14 // seconds between shots at fireMult = 1
const PROJECTILE_SPEED = 260 * WORLD_SCALE // world units/s — outruns the plane
const PROJECTILE_LIFE = 2.0 // seconds before a bolt returns to the pool
const NOSE_OFFSET = 14 * WORLD_SCALE // spawn this far ahead so it clears the rig
const BOLT_RADIUS = 1.1 * WORLD_SCALE // visual cross-section radius
const BOLT_STRETCH = 3.2 // length-along-+Z multiplier (streak feel)
const DEFAULT_HIT_RADIUS = 4 * WORLD_SCALE // target hit radius when one is omitted
const SCORE_PER_HIT = 50 // points banked per target kill
const PARK_Y = -1e6 // far below the world: where dead instances hide

// HDR-bright hot cyan/white — > 1.0 channels crest the bloom threshold (0.9).
const BOLT_COLOR = new THREE.Color(0.4, 1.6, 2.2)

// ----- module-scoped temps (ZERO per-frame allocation) ----------------------

const _v = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _nose = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _zAxis = new THREE.Vector3(0, 0, 1) // geometry's long axis (local +Z)
const _parkScale = new THREE.Vector3(0, 0, 0)
const _identQuat = new THREE.Quaternion()

// Minimal duck-type for the optional shared NPC target list.
interface NpcTarget {
  pos: THREE.Vector3
  hitRadius?: number
  onHit?: () => void
}

export class WeaponSystem implements GameSystem {
  readonly name = 'weapon'

  // --- the single instanced draw call for every bolt ---
  private mesh: THREE.InstancedMesh | null = null
  private geometry: THREE.BufferGeometry | null = null
  private material: THREE.MeshBasicMaterial | null = null

  // --- pool state in parallel typed arrays (SoA) ---
  private readonly pos = new Float32Array(POOL_SIZE * 3) // world position
  private readonly vel = new Float32Array(POOL_SIZE * 3) // constant velocity
  private readonly life = new Float32Array(POOL_SIZE) // remaining seconds
  private readonly active = new Uint8Array(POOL_SIZE) // 1 = live, 0 = pooled

  private next = 0 // round-robin spawn cursor
  private cooldown = 0 // seconds until the next shot is allowed

  // soft glowing-dust trail left in each bolt's wake (THREE.Points, additive)
  private trail: GlowParticles | null = null

  init(ctx: GameContext): void {
    // Elongated octahedron: radius across, stretched along +Z → a glowing dart.
    const geo = new THREE.OctahedronGeometry(BOLT_RADIUS, 0)
    geo.scale(1, 1, BOLT_STRETCH)
    this.geometry = geo

    // Self-lit, tone-mapping bypassed so the >1.0 colour survives to bloom.
    const mat = new THREE.MeshBasicMaterial({ color: BOLT_COLOR, toneMapped: false })
    this.material = mat

    const mesh = new THREE.InstancedMesh(geo, mat, POOL_SIZE)
    mesh.name = 'weapon.bolts'
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
    mesh.renderOrder = 2
    this.mesh = mesh

    // Prime every instance to a zero-scale (invisible) parked matrix.
    for (let i = 0; i < POOL_SIZE; i++) {
      this.active[i] = 0
      this.life[i] = 0
      _pos.set(0, PARK_Y - i, 0)
      _m.compose(_pos, _identQuat, _parkScale)
      mesh.setMatrixAt(i, _m)
    }
    mesh.instanceMatrix.needsUpdate = true

    ctx.scene.add(mesh)

    // Ethereal glow trail — soft drifting motes instead of a flat streak.
    this.trail = new GlowParticles({
      count: 360,
      size: BOLT_RADIUS * 2.0,
      drag: 1.2,
      blending: THREE.AdditiveBlending,
      renderOrder: 3,
    })
    ctx.scene.add(this.trail.points)
  }

  /** Find a slot to fire from: a free one, else recycle the OLDEST live slot. */
  private acquireSlot(): number {
    // Prefer the round-robin cursor if it happens to be free.
    if (this.active[this.next] === 0) {
      const s = this.next
      this.next = (this.next + 1) % POOL_SIZE
      return s
    }
    // Otherwise scan for any free slot.
    for (let i = 0; i < POOL_SIZE; i++) {
      if (this.active[i] === 0) {
        this.next = (i + 1) % POOL_SIZE
        return i
      }
    }
    // Pool saturated → evict the slot with the least remaining life (oldest).
    let oldest = 0
    let leastLife = Infinity
    for (let i = 0; i < POOL_SIZE; i++) {
      const l = this.life[i]!
      if (l < leastLife) {
        leastLife = l
        oldest = i
      }
    }
    this.next = (oldest + 1) % POOL_SIZE
    return oldest
  }

  /** Spawn one bolt from the plane's nose along its frozen forward direction. */
  private fire(ctx: GameContext): void {
    const obj = ctx.player.obj

    // forward = local +Z in world space, frozen at fire time.
    _fwd.set(0, 0, 1).applyQuaternion(obj.quaternion).normalize()
    // nose world pos = plane position + forward * NOSE_OFFSET
    _nose.copy(obj.position).addScaledVector(_fwd, NOSE_OFFSET)

    const slot = this.acquireSlot()
    const p = slot * 3
    this.pos[p] = _nose.x
    this.pos[p + 1] = _nose.y
    this.pos[p + 2] = _nose.z
    this.vel[p] = _fwd.x * PROJECTILE_SPEED
    this.vel[p + 1] = _fwd.y * PROJECTILE_SPEED
    this.vel[p + 2] = _fwd.z * PROJECTILE_SPEED
    this.life[slot] = PROJECTILE_LIFE
    this.active[slot] = 1

    ctx.audio.play('fire', { volume: 0.5 })
  }

  /** Collapse a slot back to the pool and park its instance (zero scale). */
  private deactivate(slot: number): void {
    this.active[slot] = 0
    this.life[slot] = 0
    if (this.mesh) {
      _pos.set(0, PARK_Y - slot, 0)
      _m.compose(_pos, _identQuat, _parkScale)
      this.mesh.setMatrixAt(slot, _m)
    }
  }

  update(dt: number, ctx: GameContext): void {
    const mesh = this.mesh
    if (!mesh) return

    // --- firing: auto-fire while held, gated by the upgrade-scaled cooldown ---
    // `firing` (Spacebar held) is wired onto the shared input bus by main.ts but
    // isn't part of the InputState type yet, so read it through a narrow cast.
    const firing = (ctx.input as { firing?: boolean }).firing === true
    if (this.cooldown > 0) this.cooldown -= dt
    if (firing && this.cooldown <= 0) {
      const upgrades = (ctx as { upgrades?: { fireMult?: number } }).upgrades
      const fireMult = Math.max(1, upgrades?.fireMult ?? 1)
      this.cooldown = FIRE_INTERVAL / fireMult
      this.fire(ctx)
    }

    // Optional NPC targets, resolved once per frame.
    const targets = (ctx as { npcTargets?: NpcTarget[] }).npcTargets
    const hasTargets = Array.isArray(targets) && targets.length > 0

    // --- integrate every live bolt ---
    let dirty = false
    for (let s = 0; s < POOL_SIZE; s++) {
      if (this.active[s] === 0) continue
      dirty = true
      const p = s * 3

      // advance on a gravity-less straight line
      this.pos[p] += this.vel[p]! * dt
      this.pos[p + 1] += this.vel[p + 1]! * dt
      this.pos[p + 2] += this.vel[p + 2]! * dt
      _pos.set(this.pos[p]!, this.pos[p + 1]!, this.pos[p + 2]!)

      // lifetime
      let life = this.life[s]! - dt

      // NPC collision (squared distance; allocation-free)
      let hit = false
      if (hasTargets) {
        for (let i = 0; i < targets!.length; i++) {
          const tgt = targets![i]
          if (!tgt || !tgt.pos) continue
          _v.copy(tgt.pos).sub(_pos)
          const r = tgt.hitRadius ?? DEFAULT_HIT_RADIUS
          if (_v.lengthSq() <= r * r) {
            hit = true
            tgt.onHit?.()
            const sc = (ctx as { score?: number }).score
            ;(ctx as { score?: number }).score = (typeof sc === 'number' ? sc : 0) + SCORE_PER_HIT
            break
          }
        }
      }

      if (hit || life <= 0) {
        this.deactivate(s)
        continue
      }
      this.life[s] = life

      // glowing dust in the bolt's wake — soft HDR motes that bloom + drift
      if (this.trail) {
        const j = BOLT_RADIUS * 2.4
        this.trail.emit(
          _pos.x, _pos.y, _pos.z,
          (ctx.rand() - 0.5) * j, (ctx.rand() - 0.5) * j, (ctx.rand() - 0.5) * j,
          0.38, BOLT_RADIUS * 2.0,
          0.5, 1.7, 2.3
        )
      }

      // orient the bolt to its velocity (+Z → normalized velocity) so it streaks
      _fwd.set(this.vel[p]!, this.vel[p + 1]!, this.vel[p + 2]!).normalize()
      _quat.setFromUnitVectors(_zAxis, _fwd)
      _scale.set(1, 1, 1)
      _m.compose(_pos, _quat, _scale)
      mesh.setMatrixAt(s, _m)
    }

    if (dirty) mesh.instanceMatrix.needsUpdate = true
    this.trail?.update(dt)
  }

  dispose(): void {
    this.trail?.dispose()
    this.trail = null
    if (this.mesh) {
      this.mesh.parent?.remove(this.mesh)
      this.mesh = null
    }
    if (this.geometry) {
      this.geometry.dispose()
      this.geometry = null
    }
    if (this.material) {
      this.material.dispose()
      this.material = null
    }
  }
}
