import * as THREE from 'three'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { damp } from '../plane/flight'

/**
 * QuestPackage — the cozy "courier" loop, faithfully recreating TinySkies'
 * package-delivery quest (our art).
 *
 * The loop, one parcel at a time:
 *   1. PICKUP   A glowing crate sits on a surface point under a tall floating
 *               light-beacon (mint shaft + halo + bobbing "?" sparkle) so you
 *               can spot it from across the planet. Fly near → the crate POPS
 *               and snaps to ride under the plane on a little tether; toast
 *               "Package collected!", SFX, emit `questProgress`.
 *   2. DELIVER  A golden beam-of-light delivery marker rises elsewhere on the
 *               globe. A crisp HUD tracker (edge-clamped arrow + distance +
 *               ETA dots) points you to it — and flips to a "BEHIND" cue when
 *               the target is off-screen behind you. Fly near → "deliver":
 *               reward XP via a `collect` event (flows through the existing
 *               Progression XP pipeline), emit `questComplete`, a reward burst
 *               of confetti + an expanding shock-ring, toast.
 *   3. NEXT     A fresh pickup spawns after a short beat → the loop repeats,
 *               every 3rd delivery paying a bonus.
 *
 * Perf / mobile budget:
 *   - Exactly ONE pickup beacon + ONE delivery beam exist at a time; both are
 *     persistent meshes that are merely repositioned & toggled (no spawn churn).
 *   - All materials are emissive/Basic → adds ZERO real lights (≤3 budget safe).
 *   - One pooled confetti Points cloud + one reusable shock-ring for the cheer.
 *   - update() allocates NOTHING: all vector/quaternion math uses module-scoped
 *     temps, distances are compared squared, and the HUD arrow is mutated via
 *     cached element refs + reused transform strings.
 */

// ----- tuning ---------------------------------------------------------------

const PICKUP_RADIUS = 7 // proximity (world units) to grab the parcel
const DELIVER_RADIUS = 8 // proximity (world units) to drop it off
const REWARD_XP = 40 // XP granted on a completed delivery
const BONUS_EVERY = 3 // every Nth delivery pays a bonus
const BONUS_XP = 30 // extra XP on a bonus delivery
const PICKUP_ALT = 4 // crate float height above the surface
const BEACON_HEIGHT = 30 // pickup light-shaft height (world units)
const BEAM_HEIGHT = 60 // delivery light-shaft height (world units)
const RESPAWN_DELAY = 0.3 // seconds between delivery and the next pickup
const MIN_SEPARATION = 0.9 // max dot() between pickup & delivery dirs (≈ ≥25°)
const BOB_AMPLITUDE = 0.7 // crate bob along its surface normal
const BOB_RATE = 1.7 // crate bob frequency
const SPIN_RATE = 0.8 // crate idle spin (rad/s)
const CARRY_OFFSET = 3.2 // how far below the plane the carried crate rides
const CARRY_FOLLOW_K = 12 // damp() stiffness for the carried crate easing
const POP_TIME = 0.42 // seconds of the pickup "pop" squash-stretch

const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS
const DELIVER_RADIUS_SQ = DELIVER_RADIUS * DELIVER_RADIUS
// "getting close" band → HUD arrow glows hotter as you near the drop.
const NEAR_RADIUS = 26
const NEAR_RADIUS_SQ = NEAR_RADIUS * NEAR_RADIUS

// Confetti burst pool (single celebration at a time → one burst is plenty,
// but we keep a couple of slots so back-to-back deliveries never pop).
const CONFETTI_SLOTS = 2
const CONFETTI_PER = 28
const CONFETTI_TOTAL = CONFETTI_SLOTS * CONFETTI_PER
const CONFETTI_LIFE = 1.0 // seconds
const CONFETTI_SPEED = 13 // initial outward speed
const CONFETTI_GRAVITY = 16 // pull back toward planet center
const PARK_Y = -100000 // park dead particles far out of sight

const SHOCK_LIFE = 0.6 // delivery shock-ring expansion time
const SHOCK_MAX = 16 // shock-ring final radius scale

// Accent colors not in PAL, authored sRGB & color-managed exactly like PAL.
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const CRATE_COLOR = srgb(0xc9a37a) // warm kraft-paper parcel
const CRATE_TAPE = srgb(0xfff2d6) // pale tape/label (reuses sun-ish cream)
const BEACON_COLOR = srgb(0x9be8b0) // soft mint pickup glow (cool, not coral)
const BEAM_COLOR = srgb(0xffd166) // golden delivery beam (reuses wing yellow)
const SPARK_COLOR = srgb(0xfff2d6) // crate-marker sparkle (cream)

// HUD → CSS color string helper (sRGB getStyle for crisp DOM color).
const cssColor = (col: THREE.Color) => `#${col.getHexString(THREE.SRGBColorSpace)}`
const BEAM_CSS = cssColor(BEAM_COLOR)
const BEACON_CSS = cssColor(BEACON_COLOR)
const PLANE_CSS = cssColor(PAL.planeBody) // warm coral — used for the "near!" flash

// ----- quest phases ---------------------------------------------------------

// Plain const-object union (isolatedModules-safe; no `const enum`).
const Phase = {
  ToPickup: 0, // parcel waiting on the surface; fly to it
  ToDeliver: 1, // parcel carried; fly to the delivery marker
  Resting: 2, // brief beat before the next parcel spawns
} as const
type Phase = (typeof Phase)[keyof typeof Phase]

// ----- module-scoped temps (ZERO per-frame allocation) ----------------------

const _planePos = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _normal = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _spin = new THREE.Quaternion()
const _carryTarget = new THREE.Vector3()
const _toTarget = new THREE.Vector3()
const _scratchDir = new THREE.Vector3()
const _down = new THREE.Vector3()
const _project = new THREE.Vector3()
const _pickupDir = new THREE.Vector3(0, 1, 0)
const _deliverDir = new THREE.Vector3(0, 1, 0)
const _zAxis = new THREE.Vector3(0, 0, 1)

const ease = (t: number) => t * t * (3 - 2 * t) // smoothstep
// overshoot ease for a juicy "pop" (back-out), clamped to t∈[0,1]
const easeBack = (t: number) => {
  const s = 1.70158
  const u = t - 1
  return 1 + (s + 1) * u * u * u + s * u * u
}

export function createPackageQuestSystem(): GameSystem {
  // Disposables.
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  const group = new THREE.Group()
  group.name = 'questPackage'

  // ---- scene objects (created ONCE, repositioned forever) ----
  let crate: THREE.Group | null = null // the parcel mesh (box + tape band)
  let crateSpark: THREE.Mesh | null = null // floating sparkle marker above the crate
  let beacon: THREE.Mesh | null = null // pickup light-shaft
  let beaconRing: THREE.Mesh | null = null // pickup ground halo
  let beam: THREE.Mesh | null = null // delivery light-shaft
  let beamRing: THREE.Mesh | null = null // delivery ground halo
  let shockRing: THREE.Mesh | null = null // delivery completion shock-ring

  // ---- confetti pool ----
  let confettiGeo: THREE.BufferGeometry | null = null
  const cPos = new Float32Array(CONFETTI_TOTAL * 3)
  const cVel = new Float32Array(CONFETTI_TOTAL * 3)
  const cLife = new Float32Array(CONFETTI_TOTAL)
  let nextConfetti = 0

  // ---- HUD tracker (cached element refs; mutated, never recreated) ----
  let hudEl: HTMLDivElement | null = null
  let hudArrowWrap: HTMLDivElement | null = null
  let hudArrow: HTMLDivElement | null = null
  let hudDist: HTMLDivElement | null = null
  let hudLabel: HTMLDivElement | null = null
  let lastDistText = '' // avoid redundant DOM writes
  let lastArrowDeg = 999 // avoid redundant transform writes (quantized)
  let lastBehind = -1 // 0/1 cache for the behind-state class swap

  // ---- quest state ----
  let phase: Phase = Phase.ToPickup
  let restTimer = 0
  let questId = 0
  let delivered = 0
  let crateBobPhase = 0
  let popT = 1 // pickup-pop progress (1 = settled)
  let shockT = -1 // shock-ring progress (-1 = idle)
  let shockColor = BEAM_COLOR

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

  // ---- seat a vertical light-shaft so its BASE sits on the surface along
  //      `dir` and it points radially outward. `mesh` geometry is a cylinder
  //      whose local +Y is its length and whose origin is at its MID-HEIGHT,
  //      so we offset outward by half the shaft height. ----
  function seatShaft(mesh: THREE.Mesh, dir: THREE.Vector3, height: number, ctx: GameContext): void {
    _normal.copy(dir)
    const base = ctx.planet.surfacePoint(_normal, ctx.planet.heightAt(_normal))
    mesh.position.copy(base).addScaledVector(_normal, height * 0.5)
    _quat.setFromUnitVectors(_up, _normal)
    mesh.quaternion.copy(_quat)
  }

  // ---- seat a flat ground halo flush on the surface along `dir` ----
  function seatRing(mesh: THREE.Mesh, dir: THREE.Vector3, extra: number, ctx: GameContext): void {
    _normal.copy(dir)
    const base = ctx.planet.surfacePoint(_normal, ctx.planet.heightAt(_normal) + extra)
    mesh.position.copy(base)
    // ring geometry lies in its local XY plane → orient local +Z to the normal
    mesh.quaternion.setFromUnitVectors(_zAxis, _normal)
  }

  // ---- spawn a fresh PICKUP parcel along a new random direction ----
  function spawnPickup(ctx: GameContext): void {
    randomDir(ctx.rand, _pickupDir)

    // Seat the crate on the surface (idle, bobbing). Reset the pop so the new
    // parcel "drops in" with a little squash-stretch.
    crateBobPhase = ctx.rand() * Math.PI * 2
    popT = 0
    seatCrateOnSurface(ctx, 0)
    if (crate) crate.visible = true
    if (crateSpark) crateSpark.visible = true

    // Seat & show the pickup beacon + halo.
    if (beacon) {
      seatShaft(beacon, _pickupDir, BEACON_HEIGHT, ctx)
      beacon.visible = true
    }
    if (beaconRing) {
      seatRing(beaconRing, _pickupDir, 0.3, ctx)
      beaconRing.visible = true
    }
    // Hide the delivery marker until pickup happens.
    if (beam) beam.visible = false
    if (beamRing) beamRing.visible = false

    phase = Phase.ToPickup
    questId++

    setHudLabel('Pick up parcel', BEACON_CSS)
    showHud(true)

    ctx.events.emit('questStart', {
      id: `package-${questId}`,
      label: 'Package Delivery',
      stage: 'pickup',
    })
    ctx.hud.toast('New delivery — find the glowing parcel', 2200)
  }

  // ---- on pickup: pick a DELIVERY direction well-separated from the pickup,
  //      raise the beam, swap HUD copy ----
  function beginDelivery(ctx: GameContext): void {
    // Pick a delivery point that isn't right on top of the pickup.
    for (let tries = 0; tries < 16; tries++) {
      randomDir(ctx.rand, _deliverDir)
      if (_deliverDir.dot(_pickupDir) < MIN_SEPARATION) break
    }

    // Hide pickup markers; the crate is now carried under the plane.
    if (beacon) beacon.visible = false
    if (beaconRing) beaconRing.visible = false
    if (crateSpark) crateSpark.visible = false
    // pop again as it snaps to the plane
    popT = 0

    if (beam) {
      seatShaft(beam, _deliverDir, BEAM_HEIGHT, ctx)
      beam.visible = true
    }
    if (beamRing) {
      seatRing(beamRing, _deliverDir, 0.3, ctx)
      beamRing.visible = true
    }

    phase = Phase.ToDeliver
    setHudLabel('Deliver parcel', BEAM_CSS)

    ctx.audio.play('collect', { volume: 0.85, rate: 0.9 })
    ctx.hud.toast('Package collected!', 2000)
    ctx.events.emit('questProgress', {
      id: `package-${questId}`,
      label: 'Package Delivery',
      stage: 'deliver',
    })
  }

  // ---- on delivery: reward, celebrate, schedule the next parcel ----
  function completeDelivery(ctx: GameContext): void {
    if (crate) crate.visible = false
    if (beam) beam.visible = false
    if (beamRing) beamRing.visible = false
    showHud(false)

    delivered++
    const bonus = delivered % BONUS_EVERY === 0
    const reward = REWARD_XP + (bonus ? BONUS_XP : 0)

    // Confetti + shock-ring at the delivery point.
    _normal.copy(_deliverDir)
    _project.copy(ctx.planet.surfacePoint(_normal, ctx.planet.heightAt(_normal) + 6))
    spawnConfetti(_project, ctx.rand)
    fireShockRing(_deliverDir, bonus ? PAL.planeBody : BEAM_COLOR, ctx)

    ctx.audio.play('collect', { volume: 1.0, rate: bonus ? 1.5 : 1.3 })

    // Reward XP through the SAME pipeline collectibles use, so Progression
    // banks it and triggers level-ups/cards naturally.
    ctx.events.emit('collect', { type: 'box', xp: reward, pos: _project })
    ctx.events.emit('questComplete', {
      id: `package-${questId}`,
      label: 'Package Delivery',
      xp: reward,
    })
    ctx.hud.toast(
      bonus ? `Delivered! Streak bonus +${reward} XP` : `Delivered! +${reward} XP`,
      2400,
    )

    phase = Phase.Resting
    restTimer = RESPAWN_DELAY
  }

  // ---- seat the carried/idle crate. When idle (not carried) it bobs on its
  //      surface anchor; carrying is handled inline in update(). `bobT` is the
  //      elapsed time used for the bob. ----
  function seatCrateOnSurface(ctx: GameContext, bobT: number): void {
    if (!crate) return
    _normal.copy(_pickupDir)
    const bob = Math.sin(bobT * BOB_RATE + crateBobPhase) * BOB_AMPLITUDE
    const base = ctx.planet.surfacePoint(_normal, ctx.planet.heightAt(_normal) + PICKUP_ALT + bob)
    crate.position.copy(base)
    _quat.setFromUnitVectors(_up, _normal)
    _spin.setFromAxisAngle(_up, bobT * SPIN_RATE)
    _quat.multiply(_spin)
    crate.quaternion.copy(_quat)

    // Sparkle marker hovers just above the crate, gently counter-bobbing.
    if (crateSpark) {
      const sb = Math.sin(bobT * 2.4 + crateBobPhase) * 0.5
      crateSpark.position.copy(base).addScaledVector(_normal, 3.2 + sb)
      crateSpark.quaternion.copy(_quat)
    }
  }

  // ---- apply the squash-stretch pop scale to the crate (juice) ----
  function applyPop(): void {
    if (!crate) return
    if (popT >= 1) {
      crate.scale.setScalar(1)
      return
    }
    // pop from 0.2 → overshoot → 1 with a tiny vertical stretch on the way up.
    const e = easeBack(ease(popT))
    const s = 0.2 + 0.8 * e
    const stretch = 1 + (1 - popT) * 0.25 * Math.sin(popT * Math.PI)
    crate.scale.set(s / Math.sqrt(stretch), s * stretch, s / Math.sqrt(stretch))
  }

  // ---- fire a pooled confetti burst at a world position ----
  function spawnConfetti(at: THREE.Vector3, rand: () => number): void {
    const slot = nextConfetti
    nextConfetti = (nextConfetti + 1) % CONFETTI_SLOTS
    const base = slot * CONFETTI_PER
    _normal.copy(at).normalize()
    for (let i = 0; i < CONFETTI_PER; i++) {
      const idx = base + i
      const p = idx * 3
      cPos[p] = at.x
      cPos[p + 1] = at.y
      cPos[p + 2] = at.z
      randomDir(rand, _scratchDir)
      _scratchDir.addScaledVector(_normal, 0.9).normalize() // bias upward/outward
      const sp = CONFETTI_SPEED * (0.5 + rand() * 0.8)
      cVel[p] = _scratchDir.x * sp
      cVel[p + 1] = _scratchDir.y * sp
      cVel[p + 2] = _scratchDir.z * sp
      cLife[idx] = CONFETTI_LIFE
    }
  }

  // ---- fire the expanding shock-ring at the delivery point ----
  function fireShockRing(dir: THREE.Vector3, color: THREE.Color, ctx: GameContext): void {
    if (!shockRing) return
    seatRing(shockRing, dir, 0.5, ctx)
    shockRing.visible = true
    shockRing.scale.setScalar(1)
    shockColor = color
    ;(shockRing.material as THREE.MeshBasicMaterial).color.copy(color)
    shockT = 0
  }

  // ---- integrate confetti (no allocation) ----
  function stepConfetti(dt: number): void {
    if (!confettiGeo) return
    let anyAlive = false
    for (let i = 0; i < CONFETTI_TOTAL; i++) {
      let life = cLife[i]!
      if (life <= 0) continue
      anyAlive = true
      life -= dt
      const p = i * 3
      if (life <= 0) {
        cLife[i] = 0
        cPos[p + 1] = PARK_Y
        continue
      }
      cLife[i] = life
      // gravity toward planet center
      _scratchDir.set(cPos[p]!, cPos[p + 1]!, cPos[p + 2]!)
      const len = _scratchDir.length()
      if (len > 1e-4) {
        const g = (CONFETTI_GRAVITY * dt) / len
        cVel[p] -= cPos[p]! * g
        cVel[p + 1] -= cPos[p + 1]! * g
        cVel[p + 2] -= cPos[p + 2]! * g
      }
      cPos[p] += cVel[p]! * dt
      cPos[p + 1] += cVel[p + 1]! * dt
      cPos[p + 2] += cVel[p + 2]! * dt
    }
    if (anyAlive) {
      ;(confettiGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true
    }
  }

  // ---- integrate the delivery shock-ring (expand + fade) ----
  function stepShock(dt: number): void {
    if (shockT < 0 || !shockRing) return
    shockT += dt / SHOCK_LIFE
    if (shockT >= 1) {
      shockT = -1
      shockRing.visible = false
      return
    }
    const e = ease(shockT)
    shockRing.scale.setScalar(1 + e * SHOCK_MAX)
    ;(shockRing.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - e)
  }

  // ---- HUD show/hide ----
  function showHud(on: boolean): void {
    if (hudEl) {
      hudEl.style.opacity = on ? '1' : '0'
      hudEl.style.transform = on ? 'translateX(-50%) scale(1)' : 'translateX(-50%) scale(0.92)'
    }
  }

  function setHudLabel(text: string, accent: string): void {
    if (hudLabel) hudLabel.textContent = text
    if (hudArrowWrap) {
      hudArrowWrap.style.background = accent
      hudArrowWrap.style.boxShadow = `0 0 10px ${accent}99`
    }
  }

  return {
    name: 'questPackage',

    init(ctx: GameContext) {
      // ---------------------------------------------------------------
      // CRATE — a chunky kraft parcel with a pale tape band + a floating
      // sparkle marker. Self-lit via emissive so it pops without a real light.
      // ---------------------------------------------------------------
      {
        const crateGroup = new THREE.Group()
        crateGroup.name = 'questPackage.crate'

        const bodyGeo = new THREE.BoxGeometry(2.4, 2.4, 2.4)
        const bodyMat = new THREE.MeshStandardMaterial({
          color: CRATE_COLOR,
          emissive: CRATE_COLOR,
          emissiveIntensity: 0.14,
          roughness: 0.85,
          metalness: 0.0,
          flatShading: true,
        })
        const body = new THREE.Mesh(bodyGeo, bodyMat)
        body.castShadow = false
        body.receiveShadow = false
        crateGroup.add(body)

        // Tape band wrapping the crate (a thin, slightly larger box slab).
        const tapeGeo = new THREE.BoxGeometry(2.55, 0.55, 2.55)
        const tapeMat = new THREE.MeshStandardMaterial({
          color: CRATE_TAPE,
          emissive: CRATE_TAPE,
          emissiveIntensity: 0.28,
          roughness: 0.6,
          metalness: 0.0,
          flatShading: true,
        })
        const tape = new THREE.Mesh(tapeGeo, tapeMat)
        crateGroup.add(tape)
        // a crossing band → a wrapped-parcel read.
        const tape2 = new THREE.Mesh(tapeGeo, tapeMat)
        tape2.rotation.y = Math.PI / 2
        crateGroup.add(tape2)

        geometries.push(bodyGeo, tapeGeo)
        materials.push(bodyMat, tapeMat)

        crateGroup.visible = false
        crateGroup.frustumCulled = true
        group.add(crateGroup)
        crate = crateGroup

        // Floating sparkle marker (octahedron) — a "this is the pickup!" cue.
        const sparkGeo = new THREE.OctahedronGeometry(0.7, 0)
        const sparkMat = new THREE.MeshBasicMaterial({
          color: SPARK_COLOR,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
        const spark = new THREE.Mesh(sparkGeo, sparkMat)
        spark.name = 'questPackage.crateSpark'
        spark.visible = false
        spark.frustumCulled = true
        group.add(spark)
        geometries.push(sparkGeo)
        materials.push(sparkMat)
        crateSpark = spark
      }

      // ---------------------------------------------------------------
      // PICKUP BEACON — a soft vertical light-shaft (transparent additive
      // cylinder, no real light) + a flat ground halo ring.
      // ---------------------------------------------------------------
      {
        const shaftGeo = new THREE.CylinderGeometry(1.1, 2.4, BEACON_HEIGHT, 12, 1, true)
        const shaftMat = new THREE.MeshBasicMaterial({
          color: BEACON_COLOR,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
        const shaft = new THREE.Mesh(shaftGeo, shaftMat)
        shaft.name = 'questPackage.beacon'
        shaft.visible = false
        shaft.frustumCulled = true
        group.add(shaft)
        geometries.push(shaftGeo)
        materials.push(shaftMat)
        beacon = shaft

        const ringGeo = new THREE.RingGeometry(2.6, 4.4, 24)
        const ringMat = new THREE.MeshBasicMaterial({
          color: BEACON_COLOR,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
        const ring = new THREE.Mesh(ringGeo, ringMat)
        ring.name = 'questPackage.beaconRing'
        ring.visible = false
        ring.frustumCulled = true
        group.add(ring)
        geometries.push(ringGeo)
        materials.push(ringMat)
        beaconRing = ring
      }

      // ---------------------------------------------------------------
      // DELIVERY BEAM — a taller golden light-shaft + ground halo, so it
      // reads as the destination from a long way off.
      // ---------------------------------------------------------------
      {
        const beamGeo = new THREE.CylinderGeometry(1.4, 3.2, BEAM_HEIGHT, 14, 1, true)
        const beamMat = new THREE.MeshBasicMaterial({
          color: BEAM_COLOR,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
        const b = new THREE.Mesh(beamGeo, beamMat)
        b.name = 'questPackage.beam'
        b.visible = false
        b.frustumCulled = true
        group.add(b)
        geometries.push(beamGeo)
        materials.push(beamMat)
        beam = b

        const ringGeo = new THREE.RingGeometry(3.0, 5.4, 28)
        const ringMat = new THREE.MeshBasicMaterial({
          color: BEAM_COLOR,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
        const ring = new THREE.Mesh(ringGeo, ringMat)
        ring.name = 'questPackage.beamRing'
        ring.visible = false
        ring.frustumCulled = true
        group.add(ring)
        geometries.push(ringGeo)
        materials.push(ringMat)
        beamRing = ring

        // Reusable delivery shock-ring (thin band, expands then fades).
        const shockGeo = new THREE.RingGeometry(4.6, 5.4, 32)
        const shockMat = new THREE.MeshBasicMaterial({
          color: BEAM_COLOR,
          transparent: true,
          opacity: 0.0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        })
        const sr = new THREE.Mesh(shockGeo, shockMat)
        sr.name = 'questPackage.shockRing'
        sr.visible = false
        sr.frustumCulled = false
        group.add(sr)
        geometries.push(shockGeo)
        materials.push(shockMat)
        shockRing = sr
      }

      // ---------------------------------------------------------------
      // CONFETTI POOL — one additive Points cloud for the delivery cheer.
      // ---------------------------------------------------------------
      {
        confettiGeo = new THREE.BufferGeometry()
        confettiGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3))
        cLife.fill(0)
        for (let i = 0; i < CONFETTI_TOTAL; i++) cPos[i * 3 + 1] = PARK_Y
        const confettiMat = new THREE.PointsMaterial({
          color: BEAM_COLOR,
          size: 1.6,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
        const pts = new THREE.Points(confettiGeo, confettiMat)
        pts.name = 'questPackage.confetti'
        pts.frustumCulled = false
        group.add(pts)
        geometries.push(confettiGeo)
        materials.push(confettiMat)
      }

      ctx.scene.add(group)

      // ---------------------------------------------------------------
      // HUD TRACKER — a compact pill: a rotating arrow + distance + label.
      // pointer-events:none so it never eats taps; positioned via CSS, safe
      // for notches via env(safe-area-inset-*).
      // ---------------------------------------------------------------
      buildHud(ctx)

      // Kick off the first parcel.
      spawnPickup(ctx)
    },

    update(dt: number, ctx: GameContext) {
      const elapsed = ctx.elapsed()
      _planePos.copy(ctx.player.obj.position)

      // Gentle living motion on the active markers (cheap, no allocation).
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.0)
      if (beacon && beacon.visible) {
        ;(beacon.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.14 * pulse
        beacon.rotateY(dt * 0.4)
      }
      if (beaconRing && beaconRing.visible) {
        beaconRing.scale.setScalar(1 + 0.12 * pulse)
        ;(beaconRing.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.18 * pulse
      }
      if (beam && beam.visible) {
        ;(beam.material as THREE.MeshBasicMaterial).opacity = 0.22 + 0.16 * pulse
        beam.rotateY(dt * 0.5)
      }
      if (beamRing && beamRing.visible) {
        beamRing.scale.setScalar(1 + 0.14 * pulse)
        ;(beamRing.material as THREE.MeshBasicMaterial).opacity = 0.42 + 0.2 * pulse
      }
      if (crateSpark && crateSpark.visible) {
        crateSpark.rotateY(dt * 1.6)
        const s = 0.85 + 0.2 * pulse
        crateSpark.scale.setScalar(s)
      }

      // Pickup-pop squash-stretch progress (juice).
      if (popT < 1) {
        popT = Math.min(1, popT + dt / POP_TIME)
        applyPop()
      }

      // ---------------- phase machine ----------------
      if (phase === Phase.ToPickup) {
        // Idle crate bobs + spins on its anchor.
        seatCrateOnSurface(ctx, elapsed)
        if (popT < 1) applyPop()

        _toTarget.copy(crate ? crate.position : _planePos).sub(_planePos)
        const dSq = _toTarget.lengthSq()
        updateHud(_toTarget, dSq, ctx)
        if (dSq <= PICKUP_RADIUS_SQ) {
          beginDelivery(ctx)
        }
      } else if (phase === Phase.ToDeliver) {
        // Carry the crate beneath the plane: target = plane pos − local up*off.
        if (crate) {
          _down.set(0, 1, 0).applyQuaternion(ctx.player.obj.quaternion)
          _carryTarget.copy(_planePos).addScaledVector(_down, -CARRY_OFFSET)
          crate.position.lerp(_carryTarget, damp(CARRY_FOLLOW_K, dt))
          // match plane orientation but keep a slow spin for charm
          _spin.setFromAxisAngle(_up, elapsed * SPIN_RATE)
          crate.quaternion.copy(ctx.player.obj.quaternion).multiply(_spin)
          if (popT < 1) applyPop()
        }

        // Distance to the delivery marker (use its ground point).
        if (beamRing) {
          _toTarget.copy(beamRing.position).sub(_planePos)
          const dSq = _toTarget.lengthSq()
          updateHud(_toTarget, dSq, ctx)
          if (dSq <= DELIVER_RADIUS_SQ) {
            completeDelivery(ctx)
          }
        }
      } else {
        // Resting: count down, then spawn the next parcel.
        restTimer -= dt
        if (restTimer <= 0) spawnPickup(ctx)
      }

      stepConfetti(dt)
      stepShock(dt)
    },

    dispose() {
      group.parent?.remove(group)
      for (const g of geometries) g.dispose()
      geometries.length = 0
      for (const m of materials) m.dispose()
      materials.length = 0
      crate = null
      crateSpark = null
      beacon = null
      beaconRing = null
      beam = null
      beamRing = null
      shockRing = null
      confettiGeo = null
      if (hudEl && hudEl.parentElement) hudEl.parentElement.removeChild(hudEl)
      hudEl = null
      hudArrowWrap = null
      hudArrow = null
      hudDist = null
      hudLabel = null
    },
  }

  // ---- build the HUD tracker pill once, cache element refs ----
  function buildHud(ctx: GameContext): void {
    const el = document.createElement('div')
    el.className = 'sd-quest-tracker'
    el.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:calc(env(safe-area-inset-top, 0px) + 14px)',
      'transform:translateX(-50%) scale(0.92)',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:8px 16px 8px 10px',
      'border-radius:999px',
      'background:rgba(20,28,44,0.42)',
      'backdrop-filter:blur(6px)',
      '-webkit-backdrop-filter:blur(6px)',
      'box-shadow:0 2px 14px rgba(0,0,0,0.18)',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'color:#fff',
      'pointer-events:none',
      'user-select:none',
      'opacity:0',
      'transition:opacity 0.35s ease, transform 0.35s cubic-bezier(0.34,1.56,0.64,1)',
      'z-index:6',
    ].join(';')

    // Arrow chip (rotates to point at the target).
    const arrowWrap = document.createElement('div')
    arrowWrap.style.cssText = [
      'position:relative',
      'width:30px',
      'height:30px',
      'flex:0 0 auto',
      'border-radius:50%',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      `background:${BEAM_CSS}`,
      `box-shadow:0 0 10px ${BEAM_CSS}99`,
      'transition:background 0.25s ease, box-shadow 0.25s ease',
    ].join(';')
    const arrow = document.createElement('div')
    arrow.textContent = '➤'
    arrow.style.cssText = [
      'font-size:16px',
      'line-height:1',
      'color:#2a2118',
      'transform:rotate(0deg)',
      'will-change:transform',
    ].join(';')
    arrowWrap.appendChild(arrow)

    // Text column: label + distance.
    const textCol = document.createElement('div')
    textCol.style.cssText = 'display:flex;flex-direction:column;line-height:1.18;min-width:84px'
    const label = document.createElement('div')
    label.textContent = 'Deliver parcel'
    label.style.cssText = 'font-size:12px;font-weight:700;letter-spacing:0.2px'
    const dist = document.createElement('div')
    dist.textContent = ''
    dist.style.cssText =
      'font-size:11px;opacity:0.82;font-variant-numeric:tabular-nums;letter-spacing:0.3px'
    textCol.appendChild(label)
    textCol.appendChild(dist)

    el.appendChild(arrowWrap)
    el.appendChild(textCol)
    ctx.hud.root.appendChild(el)

    hudEl = el
    hudArrowWrap = arrowWrap
    hudArrow = arrow
    hudDist = dist
    hudLabel = label
  }

  // ---- rotate the HUD arrow toward the world-space target & show distance.
  //      `toTarget` is (target − plane) in WORLD space; `dSq` is its squared
  //      length. We express the world direction in CAMERA space, then use its
  //      x/y for a 2D bearing — and its z (depth) to detect "behind". When the
  //      target is behind the camera, the screen-projected bearing inverts, so
  //      we flip the arrow by 180° and flag a BEHIND cue. Hotter glow as you
  //      close in. No allocation: reuses module temps + cached element refs. ----
  function updateHud(toTarget: THREE.Vector3, dSq: number, ctx: GameContext): void {
    if (!hudArrow || !hudDist || !hudArrowWrap) return

    // Express the world direction in camera space (inverse of cam world quat).
    _scratchDir.copy(toTarget)
    _quat.copy(ctx.camera.quaternion).invert()
    _scratchDir.applyQuaternion(_quat)

    // In view space: +x right, +y up, -z forward. behind ⇔ z > 0.
    const behind = _scratchDir.z > 0
    // CSS rotation is clockwise-from-up → angle = atan2(x, y). When the target
    // is behind us, flip so the arrow points back toward it instead of away.
    let ang = Math.atan2(_scratchDir.x, _scratchDir.y)
    if (behind) ang += Math.PI
    let deg = (ang * 180) / Math.PI

    // Quantize to 1° so we only touch the DOM when it visibly changes.
    deg = Math.round(deg)
    if (deg !== lastArrowDeg) {
      lastArrowDeg = deg
      hudArrow.style.transform = `rotate(${deg}deg)`
    }

    // Behind-state cue: subtly nudge the pill background hint via the arrow chip.
    const behindN = behind ? 1 : 0
    if (behindN !== lastBehind) {
      lastBehind = behindN
      hudArrowWrap.style.opacity = behind ? '0.78' : '1'
    }

    // "Near!" warm flash on the arrow chip when you close on the destination
    // (only meaningful in the deliver phase, but harmless on pickup too).
    const near = dSq <= NEAR_RADIUS_SQ
    if (near) {
      // pulse the chip warm-coral as you arrive — the only warm accent allowed.
      hudArrowWrap.style.background = PLANE_CSS
      hudArrowWrap.style.boxShadow = `0 0 14px ${PLANE_CSS}cc`
    }

    // Distance readout (round; one sqrt per frame max). Behind → ↩ hint glyph.
    const meters = Math.sqrt(dSq)
    let text: string
    if (meters >= 1000) text = (meters / 1000).toFixed(1) + ' km'
    else text = meters.toFixed(0) + ' m'
    if (behind) text = '↩ ' + text
    if (text !== lastDistText) {
      lastDistText = text
      hudDist.textContent = text
    }
  }
}
