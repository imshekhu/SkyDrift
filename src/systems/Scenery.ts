import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'

// All scenery is flat-shaded + vertex-colored, so normalize every part to non-indexed
// before merging (mixing indexed + non-indexed geometries makes mergeGeometries fail).
function mergeFlat(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  return mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false)
}


/**
 * Scenery — static low-poly props scattered across the whole planet in
 * believable CLUSTERS that respect the planet's biomes.
 *
 * Each prop FAMILY is a single InstancedMesh (ONE draw call):
 *   • pine trees   — tall stacked-cone conifers (forest clusters, grass band)
 *   • round trees  — stout deciduous blobs      (forest clusters, grass band)
 *   • palm trees   — leaning trunk + frond fan   (beach rim, near water)
 *   • bushes       — squashed icosa domes        (scattered + forest understory)
 *   • flowers      — stem + 5-petal head         (meadow clusters on grass)
 *   • mushrooms    — cap + stalk                  (sparse, forest floor)
 *   • rocks        — jittered dodecahedra         (rocky-patch clusters, high band)
 *
 * Placement is BIOME-AWARE. We read ctx.planet.heightAt(dir): water (h≤0) gets
 * nothing, the snow caps near the relief ceiling get only the odd rock, the
 * sandy shoreline gets palms, the lush grass/forest band gets trees+flowers,
 * and the high stony band gets rocks. Props are grown around a set of seed
 * "cluster" directions so forests, meadows and boulder fields read as real
 * places rather than uniform confetti.
 *
 * Wind: foliage gently sways. To stay allocation-free AND cheap we keep each
 * swaying instance's BASE transform and, each frame, rewrite only a small
 * rolling budget of matrices with a tiny time-based lean. Heavy trunks/rocks
 * never move (no cost). All temps live at module/closure scope.
 */

// Per-family instance budgets (mobile-conscious; 1 draw call each).
const PINE_COUNT = 720
const ROUND_COUNT = 560
const PALM_COUNT = 200
const BUSH_COUNT = 620
const FLOWER_COUNT = 900
const MUSHROOM_COUNT = 260
const ROCK_COUNT = 720

// Scale ranges per family.
const SCALE = {
  pine: [0.85, 1.75] as const,
  round: [0.8, 1.6] as const,
  palm: [0.9, 1.45] as const,
  bush: [0.7, 1.5] as const,
  flower: [0.7, 1.3] as const,
  mushroom: [0.6, 1.25] as const,
  rock: [0.6, 1.9] as const,
}

// ── Biome thresholds, expressed as a fraction of planet radius. ──────────────
// heightAt() returns terrain height above base radius: water clamps to a small
// negative (-WATER_INSET·r), land rises to ~RELIEF·r (≈0.085·r) at the peaks.
// We classify with normalized land height t = h / (RELIEF·r) ∈ roughly [0..1].
const RELIEF = 0.085 // mirrors Planet.ts RELIEF (read-only constant; no import)
const SHORE_T = 0.02 // just above the water line → sandy beach band
const BEACH_T = 0.12 // palms thrive between SHORE_T and BEACH_T
const GRASS_LO = 0.06 // lush grass/forest band lower edge
const GRASS_HI = 0.62 // … upper edge (above this, terrain turns stony)
const ROCK_LO = 0.55 // stony band lower edge (rocks start appearing)
const SNOW_T = 0.9 // above this is snow cap → bare (nothing grows)

export function createScenerySystem(): GameSystem {
  // Disposable handles, captured at init for dispose().
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  const meshes: THREE.InstancedMesh[] = []

  // Wind bookkeeping (filled at init). Each entry = one swaying family.
  type Swayer = {
    mesh: THREE.InstancedMesh
    basePos: Float32Array // xyz per instance (world)
    baseQuat: Float32Array // xyzw per instance
    scale: Float32Array // uniform scale per instance
    normal: Float32Array // surface normal (sway tilt axis source) per instance
    phase: Float32Array // per-instance phase offset
    amp: number // max lean (radians)
    used: number // how many instances actually placed
    cursor: number // rolling write cursor for budgeted updates
  }
  const swayers: Swayer[] = []

  return {
    name: 'scenery',

    init(ctx: GameContext) {
      const rand = ctx.rand
      const radius = ctx.planet.radius
      const reliefWorld = RELIEF * radius

      // ---- temps reused across the whole build loop (no per-instance alloc) ----
      const dir = new THREE.Vector3()
      const up = new THREE.Vector3(0, 1, 0)
      const pos = new THREE.Vector3()
      const quat = new THREE.Quaternion()
      const spin = new THREE.Quaternion()
      const scaleVec = new THREE.Vector3()
      const matrix = new THREE.Matrix4()
      const yAxis = new THREE.Vector3(0, 1, 0)
      const probe = new THREE.Vector3()

      // Normalized land height t at a unit dir: <0 → water, ~[0..1] → land.
      const landT = (d: THREE.Vector3): number => {
        const h = ctx.planet.heightAt(d)
        return h <= 0 ? -1 : h / reliefWorld
      }

      // Uniform random unit direction into `dir` (z-uniform sphere sampling).
      const randomDir = (out: THREE.Vector3): THREE.Vector3 => {
        const z = rand() * 2 - 1
        const t = rand() * Math.PI * 2
        const r = Math.sqrt(Math.max(0, 1 - z * z))
        out.set(r * Math.cos(t), z, r * Math.sin(t))
        if (out.lengthSq() < 1e-8) out.set(0, 1, 0)
        else out.normalize()
        return out
      }

      // Jitter a unit direction by a small angular radius (radians) into `out`.
      // Builds a tangent-plane offset then renormalizes — keeps it on the sphere.
      const tA = new THREE.Vector3()
      const tB = new THREE.Vector3()
      const jitterDir = (center: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 => {
        // tangent basis around center
        tA.set(0, 1, 0)
        if (Math.abs(center.y) > 0.95) tA.set(1, 0, 0)
        tA.crossVectors(center, tA).normalize()
        tB.crossVectors(center, tA).normalize()
        const ang = rand() * Math.PI * 2
        // sqrt → roughly uniform disc density inside the cluster
        const rad = Math.sqrt(rand()) * spread
        out.copy(center)
          .addScaledVector(tA, Math.cos(ang) * rad)
          .addScaledVector(tB, Math.sin(ang) * rad)
          .normalize()
        return out
      }

      // Orient: local +Y → surface normal; random yaw spin about the normal.
      // Optional fixed extra lean (palms) tilts the trunk for character.
      const composeAt = (
        d: THREE.Vector3,
        scale: number,
        sink: number,
        leanRad: number,
      ): THREE.Matrix4 => {
        const sp = ctx.planet.surfacePoint(d, -sink)
        pos.copy(sp)
        quat.setFromUnitVectors(up, d)
        spin.setFromAxisAngle(yAxis, rand() * Math.PI * 2)
        quat.multiply(spin)
        if (leanRad > 0) {
          spin.setFromAxisAngle(yAxis.set(1, 0, 0), leanRad)
          quat.multiply(spin)
          yAxis.set(0, 1, 0)
        }
        scaleVec.setScalar(scale)
        matrix.compose(pos, quat, scaleVec)
        return matrix
      }

      // Build cluster seed directions, each tagged with the biome we want there.
      type Cluster = { center: THREE.Vector3; spread: number }
      const makeClusters = (
        n: number,
        spreadMin: number,
        spreadMax: number,
        accept: (t: number) => boolean,
      ): Cluster[] => {
        const out: Cluster[] = []
        let tries = 0
        const maxTries = n * 40
        while (out.length < n && tries++ < maxTries) {
          const c = randomDir(probe)
          if (!accept(landT(c))) continue
          out.push({
            center: c.clone(),
            spread: spreadMin + rand() * (spreadMax - spreadMin),
          })
        }
        return out
      }

      // Place `count` instances by growing them around `clusters`, retrying a few
      // times per instance until the jittered point passes the biome `accept`.
      // Returns the number actually placed. Optionally records sway data.
      const populate = (
        mesh: THREE.InstancedMesh,
        count: number,
        clusters: Cluster[],
        accept: (t: number) => boolean,
        scaleRange: readonly [number, number],
        sinkFrac: number,
        leanRad: number,
        sway: Swayer | null,
      ): number => {
        if (clusters.length === 0) return 0
        let placed = 0
        for (let i = 0; i < count; i++) {
          let ok = false
          // up to 6 attempts to land inside the target biome
          for (let attempt = 0; attempt < 6; attempt++) {
            const cl = clusters[(rand() * clusters.length) | 0]
            jitterDir(cl.center, cl.spread, dir)
            if (accept(landT(dir))) {
              ok = true
              break
            }
          }
          if (!ok) continue
          const s = scaleRange[0] + rand() * (scaleRange[1] - scaleRange[0])
          mesh.setMatrixAt(placed, composeAt(dir, s, sinkFrac * s, leanRad))
          if (sway) {
            // cache base transform + normal so wind can rewrite matrices cheaply
            const k3 = placed * 3
            const k4 = placed * 4
            sway.basePos[k3] = pos.x
            sway.basePos[k3 + 1] = pos.y
            sway.basePos[k3 + 2] = pos.z
            sway.baseQuat[k4] = quat.x
            sway.baseQuat[k4 + 1] = quat.y
            sway.baseQuat[k4 + 2] = quat.z
            sway.baseQuat[k4 + 3] = quat.w
            sway.scale[placed] = s
            sway.normal[k3] = dir.x
            sway.normal[k3 + 1] = dir.y
            sway.normal[k3 + 2] = dir.z
            sway.phase[placed] = rand() * Math.PI * 2
          }
          placed++
        }
        mesh.count = placed
        mesh.instanceMatrix.needsUpdate = true
        return placed
      }

      // Factory: a flat-shaded vertex-colored InstancedMesh from one geometry.
      const makeMesh = (
        geo: THREE.BufferGeometry,
        name: string,
        max: number,
        doubleSide = false,
      ): THREE.InstancedMesh => {
        const mat = new THREE.MeshLambertMaterial({
          vertexColors: true,
          flatShading: true,
          side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        })
        materials.push(mat)
        const m = new THREE.InstancedMesh(geo, mat, max)
        m.name = name
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        m.frustumCulled = false
        m.castShadow = false
        m.receiveShadow = false
        return m
      }

      const newSwayer = (mesh: THREE.InstancedMesh, max: number, amp: number): Swayer => ({
        mesh,
        basePos: new Float32Array(max * 3),
        baseQuat: new Float32Array(max * 4),
        scale: new Float32Array(max),
        normal: new Float32Array(max * 3),
        phase: new Float32Array(max),
        amp,
        used: 0,
        cursor: 0,
      })

      // ── biome acceptors ──────────────────────────────────────────────────
      const onGrass = (t: number) => t >= GRASS_LO && t <= GRASS_HI
      const onForest = (t: number) => t >= GRASS_LO && t <= GRASS_HI * 0.92
      const onBeach = (t: number) => t >= SHORE_T && t <= BEACH_T
      const onRocky = (t: number) => t >= ROCK_LO && t <= SNOW_T
      const onMeadow = (t: number) => t >= GRASS_LO && t <= GRASS_HI * 0.75

      // ── cluster seed sets (shared so families co-locate believably) ───────
      const forests = makeClusters(34, 0.05, 0.12, onForest)
      const meadows = makeClusters(22, 0.04, 0.1, onMeadow)
      const beaches = makeClusters(16, 0.03, 0.07, onBeach)
      const boulders = makeClusters(20, 0.04, 0.1, onRocky)

      // ============================================================
      // PINE TREES — stacked tapering cones on a slim trunk.
      // ============================================================
      {
        const trunk = new THREE.CylinderGeometry(0.13, 0.2, 1.1, 5, 1)
        trunk.translate(0, 0.55, 0)
        paintGeometry(trunk, BARK)
        const tiers: THREE.BufferGeometry[] = [trunk]
        const tierR = [1.0, 0.78, 0.52]
        const tierH = [1.4, 1.2, 1.0]
        let y = 1.0
        for (let t = 0; t < tierR.length; t++) {
          const cone = new THREE.ConeGeometry(tierR[t], tierH[t], 6, 1)
          cone.translate(0, y + tierH[t] * 0.5, 0)
          paintGeometry(cone, t === 0 ? PINE_DARK : PAL.tree)
          tiers.push(cone)
          y += tierH[t] * 0.62
        }
        const merged = mergeFlat(tiers)
        for (const g of tiers) g.dispose()
        if (merged) {
          merged.computeVertexNormals()
          geometries.push(merged)
          const mesh = makeMesh(merged, 'scenery.pines', PINE_COUNT)
          const sway = newSwayer(mesh, PINE_COUNT, 0.05)
          const n = populate(mesh, PINE_COUNT, forests, onGrass, SCALE.pine, 0.14, 0, sway)
          sway.used = n
          finalizeMesh(mesh, radius)
          ctx.scene.add(mesh)
          meshes.push(mesh)
          swayers.push(sway)
        }
      }

      // ============================================================
      // ROUND TREES — stout deciduous blob (2-blob canopy) on a trunk.
      // ============================================================
      {
        const trunk = new THREE.CylinderGeometry(0.17, 0.24, 1.1, 5, 1)
        trunk.translate(0, 0.55, 0)
        paintGeometry(trunk, BARK)
        const lower = new THREE.IcosahedronGeometry(1.0, 0)
        lower.scale(1.05, 0.9, 1.05)
        lower.translate(0, 1.65, 0)
        paintGeometry(lower, PAL.tree)
        const upper = new THREE.IcosahedronGeometry(0.7, 0)
        upper.scale(1, 0.95, 1)
        upper.translate(0.18, 2.45, -0.1)
        paintGeometry(upper, LEAF_LIGHT)
        const merged = mergeFlat([trunk, lower, upper])
        trunk.dispose(); lower.dispose(); upper.dispose()
        if (merged) {
          merged.computeVertexNormals()
          geometries.push(merged)
          const mesh = makeMesh(merged, 'scenery.roundTrees', ROUND_COUNT)
          const sway = newSwayer(mesh, ROUND_COUNT, 0.055)
          const n = populate(mesh, ROUND_COUNT, forests, onGrass, SCALE.round, 0.13, 0, sway)
          sway.used = n
          finalizeMesh(mesh, radius)
          ctx.scene.add(mesh)
          meshes.push(mesh)
          swayers.push(sway)
        }
      }

      // ============================================================
      // PALM TREES — leaning trunk + radial frond fan. Beach rim only.
      // ============================================================
      {
        const trunk = new THREE.CylinderGeometry(0.12, 0.2, 2.4, 5, 1)
        trunk.translate(0, 1.2, 0)
        // gentle curve: nudge the top sideways for a tropical lean
        bend(trunk, 0.35)
        paintGeometry(trunk, PALM_BARK)
        const parts: THREE.BufferGeometry[] = [trunk]
        const FRONDS = 6
        for (let f = 0; f < FRONDS; f++) {
          const frond = new THREE.ConeGeometry(0.28, 1.5, 3, 1)
          frond.rotateZ(Math.PI * 0.5) // lay it on its side → points outward
          frond.translate(0.75, 0, 0) // base at trunk top
          frond.rotateX(0.5) // droop
          frond.rotateY((f / FRONDS) * Math.PI * 2)
          frond.translate(0.25, 2.45, 0)
          paintGeometry(frond, PALM_FROND)
          parts.push(frond)
        }
        const merged = mergeFlat(parts)
        for (const g of parts) g.dispose()
        if (merged) {
          merged.computeVertexNormals()
          geometries.push(merged)
          const mesh = makeMesh(merged, 'scenery.palms', PALM_COUNT)
          const sway = newSwayer(mesh, PALM_COUNT, 0.07)
          const n = populate(mesh, PALM_COUNT, beaches, onBeach, SCALE.palm, 0.1, 0, sway)
          sway.used = n
          finalizeMesh(mesh, radius)
          ctx.scene.add(mesh)
          meshes.push(mesh)
          swayers.push(sway)
        }
      }

      // ============================================================
      // BUSHES — squashed icosa dome. Forest understory + open scatter.
      // ============================================================
      {
        const base = new THREE.IcosahedronGeometry(0.55, 0)
        base.scale(1.15, 0.72, 1.15)
        jitter(base, 0.12, rand)
        base.computeVertexNormals()
        paintGeometry(base, BUSH_GREEN)
        geometries.push(base)
        const mesh = makeMesh(base, 'scenery.bushes', BUSH_COUNT)
        // half clustered in forests, half free-scattered on grass
        const half = (BUSH_COUNT / 2) | 0
        const a = populate(mesh, half, forests, onGrass, SCALE.bush, 0.18, 0, null)
        mesh.count = BUSH_COUNT // allow the scatter pass to keep filling
        const scatter = makeClusters(40, 0.08, 0.18, onGrass)
        const b = scatterFill(mesh, a, BUSH_COUNT, scatter, onGrass, landT, jitterDir, composeAt, SCALE.bush, 0.18, rand)
        mesh.count = b
        mesh.instanceMatrix.needsUpdate = true
        finalizeMesh(mesh, radius)
        ctx.scene.add(mesh)
        meshes.push(mesh)
      }

      // ============================================================
      // FLOWERS — thin stem + flat 5-petal head. Meadow clusters.
      // ============================================================
      {
        const stem = new THREE.CylinderGeometry(0.025, 0.035, 0.5, 3, 1)
        stem.translate(0, 0.25, 0)
        paintGeometry(stem, STEM_GREEN)
        const parts: THREE.BufferGeometry[] = [stem]
        const PETALS = 5
        for (let p = 0; p < PETALS; p++) {
          const petal = new THREE.CircleGeometry(0.12, 4)
          petal.rotateX(-Math.PI * 0.5)
          petal.translate(0.13, 0.5, 0)
          petal.rotateY((p / PETALS) * Math.PI * 2)
          // alternate the meadow's flower colors deterministically by petal seed
          paintGeometry(petal, p % 2 === 0 ? FLOWER_A : FLOWER_B)
          parts.push(petal)
        }
        const center = new THREE.CircleGeometry(0.06, 5)
        center.rotateX(-Math.PI * 0.5)
        center.translate(0, 0.51, 0)
        paintGeometry(center, FLOWER_CENTER)
        parts.push(center)
        const merged = mergeFlat(parts)
        for (const g of parts) g.dispose()
        if (merged) {
          merged.computeVertexNormals()
          geometries.push(merged)
          const mesh = makeMesh(merged, 'scenery.flowers', FLOWER_COUNT, true) // petals from below
          const sway = newSwayer(mesh, FLOWER_COUNT, 0.18)
          const n = populate(mesh, FLOWER_COUNT, meadows, onMeadow, SCALE.flower, 0.02, 0, sway)
          sway.used = n
          finalizeMesh(mesh, radius)
          ctx.scene.add(mesh)
          meshes.push(mesh)
          swayers.push(sway)
        }
      }

      // ============================================================
      // MUSHROOMS — domed cap + stubby stalk. Sparse forest floor.
      // ============================================================
      {
        const stalk = new THREE.CylinderGeometry(0.07, 0.1, 0.28, 5, 1)
        stalk.translate(0, 0.14, 0)
        paintGeometry(stalk, MUSH_STALK)
        const cap = new THREE.SphereGeometry(0.2, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.5)
        cap.scale(1, 0.7, 1)
        cap.translate(0, 0.28, 0)
        paintGeometry(cap, MUSH_CAP)
        const merged = mergeFlat([stalk, cap])
        stalk.dispose(); cap.dispose()
        if (merged) {
          merged.computeVertexNormals()
          geometries.push(merged)
          const mesh = makeMesh(merged, 'scenery.mushrooms', MUSHROOM_COUNT)
          populate(mesh, MUSHROOM_COUNT, forests, onForest, SCALE.mushroom, 0.04, 0, null)
          finalizeMesh(mesh, radius)
          ctx.scene.add(mesh)
          meshes.push(mesh)
        }
      }

      // ============================================================
      // ROCKS — jittered dodecahedron. Boulder clusters + high stony band.
      // ============================================================
      {
        const base = new THREE.DodecahedronGeometry(0.7, 0)
        jitter(base, 0.2, rand)
        base.computeVertexNormals()
        paintGeometry(base, STONE)
        geometries.push(base)
        const mesh = makeMesh(base, 'scenery.rocks', ROCK_COUNT)
        const accRocky = (t: number) => t >= SHORE_T && t <= SNOW_T // wide: boulders + alpine
        const a = populate(mesh, (ROCK_COUNT * 0.7) | 0, boulders, accRocky, SCALE.rock, 0.35, 0, null)
        mesh.count = ROCK_COUNT
        const highScatter = makeClusters(24, 0.05, 0.13, onRocky)
        const b = scatterFill(mesh, a, ROCK_COUNT, highScatter, onRocky, landT, jitterDir, composeAt, SCALE.rock, 0.35, rand)
        mesh.count = b
        mesh.instanceMatrix.needsUpdate = true
        finalizeMesh(mesh, radius)
        ctx.scene.add(mesh)
        meshes.push(mesh)
      }
    },

    // Subtle wind: rewrite a rolling budget of foliage matrices per frame so the
    // canopy breathes without per-frame allocation or touching every instance.
    update(dt: number, ctx: GameContext) {
      if (swayers.length === 0) return
      const t = ctx.elapsed()
      // global gust envelope (shared) keeps families coherent
      const gust = 0.65 + 0.35 * Math.sin(t * 0.5)
      // per-call budget split across all swaying families (keeps the cost flat)
      const BUDGET = 220
      const each = Math.max(8, (BUDGET / swayers.length) | 0)

      for (const s of swayers) {
        if (s.used === 0) continue
        const lean = s.amp * gust
        let written = 0
        let i = s.cursor
        const n = Math.min(each, s.used)
        while (written < n) {
          if (i >= s.used) i = 0
          applySway(s, i, t, lean)
          i++
          written++
        }
        s.cursor = i
        s.mesh.instanceMatrix.needsUpdate = true
      }
      void dt
    },

    dispose() {
      for (const m of meshes) {
        m.parent?.remove(m)
        m.dispose()
      }
      meshes.length = 0
      for (const g of geometries) g.dispose()
      geometries.length = 0
      for (const mt of materials) mt.dispose()
      materials.length = 0
      swayers.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// Wind application — allocation-free; reuses module-scope temps.
// ---------------------------------------------------------------------------

type SwayLike = {
  mesh: THREE.InstancedMesh
  basePos: Float32Array
  baseQuat: Float32Array
  scale: Float32Array
  normal: Float32Array
  phase: Float32Array
}

const _wPos = new THREE.Vector3()
const _wQuat = new THREE.Quaternion()
const _wBase = new THREE.Quaternion()
const _wTilt = new THREE.Quaternion()
const _wAxis = new THREE.Vector3()
const _wScale = new THREE.Vector3()
const _wMat = new THREE.Matrix4()
const _wTangent = new THREE.Vector3()
const _wHelper = new THREE.Vector3(0, 1, 0)

function applySway(s: SwayLike, i: number, time: number, lean: number): void {
  const k3 = i * 3
  const k4 = i * 4
  _wPos.set(s.basePos[k3], s.basePos[k3 + 1], s.basePos[k3 + 2])
  _wBase.set(s.baseQuat[k4], s.baseQuat[k4 + 1], s.baseQuat[k4 + 2], s.baseQuat[k4 + 3])
  // tilt axis: a tangent to the surface (perpendicular to the radial normal)
  _wAxis.set(s.normal[k3], s.normal[k3 + 1], s.normal[k3 + 2])
  _wHelper.set(0, 1, 0)
  if (Math.abs(_wAxis.y) > 0.95) _wHelper.set(1, 0, 0)
  _wTangent.crossVectors(_wAxis, _wHelper).normalize()
  const ang = Math.sin(time * 1.6 + s.phase[i]) * lean
  _wTilt.setFromAxisAngle(_wTangent, ang)
  _wQuat.copy(_wTilt).multiply(_wBase)
  const sc = s.scale[i]
  _wScale.setScalar(sc)
  _wMat.compose(_wPos, _wQuat, _wScale)
  s.mesh.setMatrixAt(i, _wMat)
}

// ---------------------------------------------------------------------------
// Build-time helpers (module scope — no per-frame cost; called only in init).
// ---------------------------------------------------------------------------

// Earthy accent tokens not in PAL, authored sRGB and color-managed like PAL.
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const BARK = srgb(0x8a6a4a)
const PINE_DARK = srgb(0x2f7a48)
const LEAF_LIGHT = srgb(0x6fc47f)
const PALM_BARK = srgb(0xa8845a)
const PALM_FROND = srgb(0x4fae6a)
const STONE = srgb(0x9aa6ad)
const BUSH_GREEN = srgb(0x57a86b)
const STEM_GREEN = srgb(0x4f9e5f)
const FLOWER_A = srgb(0xff9ec4)
const FLOWER_B = srgb(0xc9a8ff)
const FLOWER_CENTER = srgb(0xffe08a)
const MUSH_STALK = srgb(0xf3ead8)
const MUSH_CAP = srgb(0xe06a6a)

/**
 * Second-pass cluster scatter: fills a mesh from `start` up to `max`, growing
 * around fresh cluster seeds and respecting `accept`. Shares the init closures
 * (jitterDir/composeAt) so geometry placement stays identical. Returns new count.
 */
function scatterFill(
  mesh: THREE.InstancedMesh,
  start: number,
  max: number,
  clusters: { center: THREE.Vector3; spread: number }[],
  accept: (t: number) => boolean,
  landT: (d: THREE.Vector3) => number,
  jitterDir: (c: THREE.Vector3, spread: number, out: THREE.Vector3) => THREE.Vector3,
  composeAt: (d: THREE.Vector3, scale: number, sink: number, lean: number) => THREE.Matrix4,
  scaleRange: readonly [number, number],
  sinkFrac: number,
  rand: () => number,
): number {
  if (clusters.length === 0) return start
  const tmp = new THREE.Vector3()
  let placed = start
  let guard = (max - start) * 8
  while (placed < max && guard-- > 0) {
    const cl = clusters[(rand() * clusters.length) | 0]
    jitterDir(cl.center, cl.spread, tmp)
    if (!accept(landT(tmp))) continue
    const s = scaleRange[0] + rand() * (scaleRange[1] - scaleRange[0])
    mesh.setMatrixAt(placed, composeAt(tmp, s, sinkFrac * s, 0))
    placed++
  }
  return placed
}

/** Write a flat per-vertex color attribute so one material can show many tints. */
function paintGeometry(geo: THREE.BufferGeometry, color: THREE.Color): void {
  const count = geo.attributes.position.count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

/** Push each vertex out/in a small random amount for organic, hand-made shape. */
function jitter(geo: THREE.BufferGeometry, amount: number, rand: () => number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const z = pos.getZ(i)
    const f = 1 + (rand() * 2 - 1) * amount
    pos.setXYZ(i, x * f, y * f, z * f)
  }
  pos.needsUpdate = true
}

/** Bend a tall geometry: shift x by amount·(y/height)² for a gentle curved lean. */
function bend(geo: THREE.BufferGeometry, amount: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  // find height range to normalize the bend
  let maxY = -Infinity
  for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i))
  const inv = maxY > 0 ? 1 / maxY : 0
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const f = y * inv
    pos.setX(i, pos.getX(i) + amount * f * f)
  }
  pos.needsUpdate = true
}

/**
 * With frustumCulled = false the renderer never tests the bounds, but a valid
 * bounding sphere keeps tooling/shadow logic honest. The field spans the whole
 * planet, so center at origin with a radius that generously covers it.
 */
function finalizeMesh(mesh: THREE.InstancedMesh, planetRadius: number): void {
  mesh.computeBoundingSphere()
  const bs = mesh.boundingSphere
  if (bs) {
    bs.center.set(0, 0, 0)
    bs.radius = planetRadius * 1.3
  }
}
