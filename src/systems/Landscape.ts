import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { GameContext, GameSystem } from '../core/types'
import { PAL } from '../art/palette'
import { WORLD_SCALE } from '../world/WorldConfig'
import { FLAT_CORE_GAP } from '../world/Planet'
import { SITES, LAND_HEIGHT, type Biome, type Site } from '../world/Sites'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Landscape
//
// Turns the blue ocean planet into islands/continents. For EACH site in SITES we
// build, seated on the BLUE CRUST shell (radius = planet.radius = 640):
//
//   1) LANDMASS  — a low, rounded, slightly-irregular dome on the local tangent
//      plane (max ~8u above crust). Coloured by biome (forest/meadow/desert/snow).
//      Its irregular edge gives a natural coastline; underside meets the crust.
//   2) COAST     — a light-sand rim ring at the waterline + a thin translucent
//      pale-turquoise shallow-water ring just outside it.
//   3) VEGETATION — biome-appropriate props scattered on the landmass top with
//      ctx.rand() (deterministic), oriented to the local surface normal. ONE
//      THREE.InstancedMesh per prop type, SHARED across every site (few draws).
//
// HARD CLEARANCE: the plane cruises at radius+64 = 704. Nothing here rises more
// than ~12u above the crust; trees cap ~8u tall → the plane clears everything.
//
// COORDINATION: the Structures system builds towns at SITES[i].dir where
// hasTown is true, so we keep a clear buildable disc at each landmass centre.
//
// Performance: landmasses/coast are static meshes merged per-biome family; props
// are InstancedMeshes. update() is a cheap, budgeted vegetation sway. dispose()
// removes everything and frees geometries/materials.
// ─────────────────────────────────────────────────────────────────────────────

const S = WORLD_SCALE
const UP_Y = new THREE.Vector3(0, 1, 0)
const srgb = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

// ── Landmass shaping (absolute world units; well under the 12u ceiling) ──────
// Dome crown is low so dome (≤5u) + a max-scale tree (≤7u) stays under the ~12u
// clearance ceiling. The plane cruises 64u above the crust, so it clears all.
const LAND_RINGS = 7 // radial subdivisions of the dome disc (finer → a clean beach band)
const LAND_SEGS = 22 // angular subdivisions (governs coastline wiggle)
const COAST_SAND_W = 7 * S // width of the sandy beach rim outside the land edge
const SHALLOW_W = 10 * S // width of the translucent shallow-water ring
const CLEAR_FRAC = 0.34 // central disc fraction kept clear of trees (town pad)

// Biome → land surface colour.
const LAND_COLOR: Record<Biome, THREE.Color> = {
  forest: srgb(0x3f8f55), // rich green
  meadow: srgb(0x8fd06a), // light green
  desert: srgb(0xe3c27e), // warm sand
  snow: srgb(0xeef2f5), // off-white
}

// Earthy accent tokens (authored sRGB, color-managed like PAL).
const SAND = srgb(0xe6cb86)
const SHALLOW = srgb(0x9fe3e0) // pale turquoise shallows
const BARK = srgb(0x8a6a4a)
const PINE_DARK = srgb(0x2f7a48)
const PINE_SNOW = srgb(0xeef4f7)
const LEAF_LIGHT = srgb(0x6fc47f)
const STONE = srgb(0x9aa6ad)
const SAND_STONE = srgb(0xc7ab78)
const BUSH_GREEN = srgb(0x57a86b)
const STEM_GREEN = srgb(0x4f9e5f)
const FLOWER_A = srgb(0xff9ec4)
const FLOWER_B = srgb(0xffe08a)
const CACTUS = srgb(0x4f9d63)
const PALM_TRUNK = srgb(0xa07a4e)
const PALM_LEAF = srgb(0x57b15f)
const HULL = srgb(0x9c6f4e)
const HULL_TRIM = srgb(0xc7625a)
const SAIL = srgb(0xf3ede0)
const SHORE_ICE = srgb(0xdfe6ec) // pale shore for snow islands (instead of sand)

// ── Per-prop-type instance budgets (one InstancedMesh each, all sites pooled). ─
// Sized so the busiest planet stays well within a few thousand props total.
const CAP = {
  pine: 1600,
  round: 900,
  bush: 700,
  flower: 900,
  rock: 700,
  cactus: 260,
  palm: 420, // coastal palms along the beaches
  boat: 240, // little sailboats moored on the water around the islands
}

// Uniform scale ranges per prop type.
const SCALE = {
  pine: [0.8, 1.5] as const,
  round: [0.8, 1.4] as const,
  bush: [0.7, 1.4] as const,
  flower: [0.7, 1.3] as const,
  rock: [0.55, 1.6] as const,
  cactus: [0.8, 1.4] as const,
  palm: [0.85, 1.5] as const,
  boat: [0.85, 1.3] as const,
}

// ── Build-time helpers (init only — no per-frame cost) ───────────────────────

// Flat-shaded + vertex-colored, so normalize to non-indexed before merging.
function mergeFlat(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  return mergeGeometries(
    list.map((g) => (g.index ? g.toNonIndexed() : g)),
    false
  )
}

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

/** A flat-shaded, vertex-colored InstancedMesh from one geometry. */
function makeInstanced(
  geo: THREE.BufferGeometry,
  name: string,
  max: number,
  doubleSide: boolean,
  materials: THREE.Material[]
): THREE.InstancedMesh {
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
  m.count = 0
  return m
}

/**
 * Curve a tangent-plane geometry onto the planet sphere. The geometry is authored
 * in a LOCAL frame where +Y is the radial-out direction and the local origin maps
 * to radius R; (x, z) are tangent offsets, y is height above the base. We reproject
 * every vertex to radius (R + y) in the direction of its tangent offset, so flat
 * discs/rings become spherical caps that HUG the globe (no flat-on-curve bowing).
 * Call this BEFORE applyFrame(); applyFrame's linear map then lands each vertex
 * exactly on the sphere of radius (R + y).
 */
function spherify(geo: THREE.BufferGeometry, R: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  const arr = pos.array as Float32Array
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i]
    const h = arr[i + 1]
    const z = arr[i + 2]
    const inv = 1 / Math.hypot(x, R, z)
    const rad = R + h
    arr[i] = x * inv * rad
    arr[i + 1] = R * inv * rad - R // keep the local origin at radius R
    arr[i + 2] = z * inv * rad
  }
  pos.needsUpdate = true
}

/**
 * A circular dome disc on the X/Z plane (local +Y up), centred at the origin,
 * with its rim at y=0 and a rounded crown at +height. The rim radius wiggles
 * per-angle for an irregular, natural coastline; the same wiggle is reused by
 * the coast builder so the beach hugs the shore. Vertex-colored to `color`.
 */
function buildLandmass(
  radius: number,
  color: THREE.Color,
  shore: THREE.Color,
  rim: Float32Array
): THREE.BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  // Rings whose dome height is within this band of the waterline are SAND (the
  // beach). Waterline = the core→crust gap; sand from a touch below it up a few u.
  const beachTop = FLAT_CORE_GAP + 4
  // ring 0 = centre, ring LAND_RINGS = coastline. Vertex grid (rings+1 × segs).
  for (let r = 0; r <= LAND_RINGS; r++) {
    const fr = r / LAND_RINGS // 0..1 outward
    // Dome profile: full height at centre → 0 at the rim (smooth cosine crown).
    const h = LAND_HEIGHT * Math.cos((fr * Math.PI) / 2)
    const c = h < beachTop ? shore : color // sandy beach band at the shoreline
    for (let s = 0; s < LAND_SEGS; s++) {
      const a = (s / LAND_SEGS) * Math.PI * 2
      // Edge irregularity grows toward the rim so the centre stays a clean pad.
      const wig = 1 + (rim[s] - 0.5) * 0.34 * fr
      const rr = radius * fr * wig
      positions.push(Math.cos(a) * rr, h, Math.sin(a) * rr)
      colors.push(c.r, c.g, c.b)
    }
  }
  for (let r = 0; r < LAND_RINGS; r++) {
    for (let s = 0; s < LAND_SEGS; s++) {
      const s2 = (s + 1) % LAND_SEGS
      const a = r * LAND_SEGS + s
      const b = r * LAND_SEGS + s2
      const c = (r + 1) * LAND_SEGS + s
      const d = (r + 1) * LAND_SEGS + s2
      indices.push(a, c, b, b, c, d)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo.toNonIndexed()
}

/**
 * A flat ring (annulus) on the X/Z plane at y, from inner→outer radius, following
 * the same `rim` wiggle as the landmass so the beach tracks the coastline.
 */
function buildRing(
  innerScale: number,
  outerR: number,
  y: number,
  color: THREE.Color,
  rim: Float32Array,
  baseR: number
): THREE.BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  for (let s = 0; s < LAND_SEGS; s++) {
    const a = (s / LAND_SEGS) * Math.PI * 2
    const wig = 1 + (rim[s] - 0.5) * 0.34 // matches the landmass rim wiggle
    const ri = baseR * innerScale * wig
    const ro = baseR * wig + outerR
    positions.push(Math.cos(a) * ri, y, Math.sin(a) * ri)
    positions.push(Math.cos(a) * ro, y, Math.sin(a) * ro)
  }
  for (let s = 0; s < LAND_SEGS; s++) {
    const s2 = (s + 1) % LAND_SEGS
    const a = s * 2
    const b = s * 2 + 1
    const c = s2 * 2
    const d = s2 * 2 + 1
    indices.push(a, b, c, b, d, c)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  paint(geo, color)
  return geo.toNonIndexed()
}

// ── Prop geometries (low-poly, flat-shaded; all ≤ ~8u tall, scale incl.) ──────

function buildPine(snow: boolean): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.13 * S * 0.6, 0.2 * S * 0.6, 1.1 * S * 0.6, 5, 1)
  trunk.translate(0, 0.55 * S * 0.6, 0)
  paint(trunk, BARK)
  const parts: THREE.BufferGeometry[] = [trunk]
  const tierR = [1.0, 0.78, 0.52]
  const tierH = [1.4, 1.2, 1.0]
  let y = 1.0 * S * 0.6
  for (let t = 0; t < tierR.length; t++) {
    const cone = new THREE.ConeGeometry(tierR[t] * S * 0.6, tierH[t] * S * 0.6, 6, 1)
    cone.translate(0, y + tierH[t] * S * 0.6 * 0.5, 0)
    paint(cone, snow ? PINE_SNOW : t === 0 ? PINE_DARK : PAL.tree)
    parts.push(cone)
    y += tierH[t] * S * 0.6 * 0.62
  }
  const merged = mergeFlat(parts)
  for (const g of parts) g.dispose()
  merged!.computeVertexNormals()
  return merged!
}

function buildRound(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.17 * S * 0.6, 0.24 * S * 0.6, 1.1 * S * 0.6, 5, 1)
  trunk.translate(0, 0.55 * S * 0.6, 0)
  paint(trunk, BARK)
  const lower = new THREE.IcosahedronGeometry(1.0 * S * 0.6, 0)
  lower.scale(1.05, 0.9, 1.05)
  lower.translate(0, 1.65 * S * 0.6, 0)
  paint(lower, PAL.tree)
  const upper = new THREE.IcosahedronGeometry(0.7 * S * 0.6, 0)
  upper.translate(0.18 * S * 0.6, 2.4 * S * 0.6, -0.1 * S * 0.6)
  paint(upper, LEAF_LIGHT)
  const merged = mergeFlat([trunk, lower, upper])
  trunk.dispose()
  lower.dispose()
  upper.dispose()
  merged!.computeVertexNormals()
  return merged!
}

function buildBush(): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(0.55 * S, 0)
  base.scale(1.15, 0.72, 1.15)
  base.translate(0, 0.32 * S, 0)
  base.computeVertexNormals()
  paint(base, BUSH_GREEN)
  return base
}

function buildFlower(): THREE.BufferGeometry {
  const stem = new THREE.CylinderGeometry(0.025 * S, 0.035 * S, 0.5 * S, 3, 1)
  stem.translate(0, 0.25 * S, 0)
  paint(stem, STEM_GREEN)
  const parts: THREE.BufferGeometry[] = [stem]
  const PETALS = 5
  for (let p = 0; p < PETALS; p++) {
    const petal = new THREE.CircleGeometry(0.12 * S, 4)
    petal.rotateX(-Math.PI * 0.5)
    petal.translate(0.13 * S, 0.5 * S, 0)
    petal.rotateY((p / PETALS) * Math.PI * 2)
    paint(petal, p % 2 === 0 ? FLOWER_A : FLOWER_B)
    parts.push(petal)
  }
  const merged = mergeFlat(parts)
  for (const g of parts) g.dispose()
  merged!.computeVertexNormals()
  return merged!
}

function buildRock(sandy: boolean): THREE.BufferGeometry {
  const base = new THREE.DodecahedronGeometry(0.7 * S, 0)
  base.scale(1, 0.7, 1)
  base.translate(0, 0.3 * S, 0)
  base.computeVertexNormals()
  paint(base, sandy ? SAND_STONE : STONE)
  return base
}

function buildCactus(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.28 * S, 0.34 * S, 2.2 * S, 7, 1)
  trunk.translate(0, 1.1 * S, 0)
  paint(trunk, CACTUS)
  const parts: THREE.BufferGeometry[] = [trunk]
  // two side arms
  for (const sx of [-1, 1]) {
    const arm = new THREE.CylinderGeometry(0.16 * S, 0.18 * S, 1.0 * S, 6, 1)
    arm.translate(0, 0.5 * S, 0)
    arm.rotateZ(sx * 0.5)
    arm.translate(sx * 0.45 * S, 1.2 * S, 0)
    paint(arm, CACTUS)
    parts.push(arm)
  }
  const merged = mergeFlat(parts)
  for (const g of parts) g.dispose()
  merged!.computeVertexNormals()
  return merged!
}

/** A leaning coconut palm: a gently curved trunk + a crown of drooping fronds. */
function buildPalm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  // curved trunk built from a few short, progressively leaning segments
  let y = 0
  let lean = 0
  const segs = 4
  const segH = 0.62 * S
  for (let i = 0; i < segs; i++) {
    const r0 = (0.16 - i * 0.02) * S
    const seg = new THREE.CylinderGeometry(r0 * 0.85, r0, segH, 6, 1)
    seg.translate(0, segH / 2, 0)
    seg.rotateZ(lean)
    seg.translate(Math.sin(i * 0.5) * 0.18 * S, y, 0)
    paint(seg, PALM_TRUNK)
    parts.push(seg)
    y += segH * Math.cos(lean)
    lean += 0.12
  }
  const topX = Math.sin(segs * 0.5) * 0.18 * S
  // a coconut cluster
  const nuts = new THREE.SphereGeometry(0.16 * S, 6, 5)
  nuts.translate(topX, y - 0.1 * S, 0.05 * S)
  paint(nuts, PALM_TRUNK)
  parts.push(nuts)
  // crown of fronds — elongated flat diamonds drooping outward
  for (let f = 0; f < 7; f++) {
    const a = (f / 7) * Math.PI * 2
    const frond = new THREE.ConeGeometry(0.22 * S, 1.5 * S, 4)
    frond.scale(1, 1, 0.18)
    frond.rotateX(Math.PI / 2) // lay it flat, pointing +Z
    frond.translate(0, 0, 0.75 * S)
    frond.rotateY(a)
    frond.rotateX(-0.5) // droop
    frond.translate(topX, y, 0)
    paint(frond, PALM_LEAF)
    parts.push(frond)
  }
  const merged = mergeFlat(parts)
  for (const g of parts) g.dispose()
  merged!.computeVertexNormals()
  return merged!
}

/** A little sailboat: a pointed hull, a trim stripe, a mast and a triangular sail. */
function buildBoat(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  // hull — a wedge-ish box, narrowed at the bow (scaled along +Z)
  const hull = new THREE.BoxGeometry(0.9 * S, 0.42 * S, 2.4 * S)
  hull.translate(0, 0.1 * S, 0)
  paint(hull, HULL)
  parts.push(hull)
  // a coloured trim stripe along the top of the hull
  const trim = new THREE.BoxGeometry(0.96 * S, 0.12 * S, 2.3 * S)
  trim.translate(0, 0.32 * S, 0)
  paint(trim, HULL_TRIM)
  parts.push(trim)
  // taper the bow: a prow cone
  const prow = new THREE.ConeGeometry(0.45 * S, 0.9 * S, 4)
  prow.rotateX(Math.PI / 2)
  prow.scale(1, 0.5, 1)
  prow.translate(0, 0.2 * S, 1.5 * S)
  paint(prow, HULL)
  parts.push(prow)
  // mast
  const mast = new THREE.CylinderGeometry(0.05 * S, 0.05 * S, 2.0 * S, 5)
  mast.translate(0, 1.2 * S, 0.1 * S)
  paint(mast, PALM_TRUNK)
  parts.push(mast)
  // triangular sail (a thin flat triangle hanging off the mast)
  const sail = new THREE.ConeGeometry(0.7 * S, 1.7 * S, 3)
  sail.scale(1, 1, 0.08)
  sail.translate(0.0, 1.25 * S, 0.45 * S)
  paint(sail, SAIL)
  parts.push(sail)
  const merged = mergeFlat(parts)
  for (const g of parts) g.dispose()
  merged!.computeVertexNormals()
  return merged!
}

// ── Per-prop-type scatter plan: which biomes host it & how many per landmass. ─
interface PropPlan {
  key: keyof typeof CAP
  // density: target props per (world-unit radius) — scales with landmass size.
  perRadius: Record<Biome, number>
}
const PLANS: PropPlan[] = [
  { key: 'pine', perRadius: { forest: 0.95, meadow: 0.12, desert: 0, snow: 0.85 } },
  { key: 'round', perRadius: { forest: 0.45, meadow: 0.22, desert: 0, snow: 0.05 } },
  { key: 'bush', perRadius: { forest: 0.3, meadow: 0.55, desert: 0.08, snow: 0.08 } },
  { key: 'flower', perRadius: { forest: 0.12, meadow: 0.8, desert: 0, snow: 0 } },
  { key: 'rock', perRadius: { forest: 0.2, meadow: 0.18, desert: 0.5, snow: 0.45 } },
  { key: 'cactus', perRadius: { forest: 0, meadow: 0, desert: 0.45, snow: 0 } },
]

// ── Sway bookkeeping (filled at init) ────────────────────────────────────────
interface Swayer {
  mesh: THREE.InstancedMesh
  basePos: Float32Array // xyz per instance (world)
  baseQuat: Float32Array // xyzw per instance
  scale: Float32Array // uniform scale per instance
  normal: Float32Array // surface normal per instance (sway axis source)
  phase: Float32Array
  amp: number
  used: number
  cursor: number
}

// Per-prop sway amplitude (radians). Heavy rocks/cacti don't move.
const SWAY_AMP: Partial<Record<keyof typeof CAP, number>> = {
  pine: 0.04,
  round: 0.05,
  bush: 0.06,
  flower: 0.16,
  palm: 0.09, // fronds sway a bit more in the sea breeze
}

export function createLandscapeSystem(): GameSystem {
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  const staticMeshes: THREE.Mesh[] = [] // landmasses + coast rings (merged per biome)
  const propMeshes: THREE.InstancedMesh[] = []
  const swayers: Swayer[] = []
  const root = new THREE.Group()
  root.name = 'landscape'

  return {
    name: 'landscape',

    init(ctx: GameContext) {
      const rand = ctx.rand
      // Seat the islands on the CORE shell (radius − FLAT_CORE_GAP), the SAME level
      // as the pinned lighthouse/city — so land + towns emerge through the blue
      // crust instead of perching on top of it.
      const R = ctx.planet.radius - FLAT_CORE_GAP

      // ---- temps reused across the whole build (no per-instance allocation) ----
      const up = new THREE.Vector3()
      const tanA = new THREE.Vector3()
      const tanB = new THREE.Vector3()
      const lp = new THREE.Vector3() // local point on the landmass frame
      const wp = new THREE.Vector3() // world point
      const wnormal = new THREE.Vector3()
      const quat = new THREE.Quaternion()
      const baseQuat = new THREE.Quaternion()
      const spin = new THREE.Quaternion()
      const scaleVec = new THREE.Vector3()
      const matrix = new THREE.Matrix4()
      const yAxis = new THREE.Vector3(0, 1, 0)

      // Per-site orientation frame: seat a local X/Z tangent plane on the sphere.
      const siteFrames: Array<{
        up: THREE.Vector3
        tanA: THREE.Vector3
        tanB: THREE.Vector3
        origin: THREE.Vector3
        baseQuat: THREE.Quaternion
      }> = []

      // Collect merged geometry per biome so all landmasses of a biome share one
      // draw call; same for coast sand and shallow water (two extra families).
      const landByBiome: Record<Biome, THREE.BufferGeometry[]> = {
        forest: [],
        meadow: [],
        desert: [],
        snow: [],
      }
      const sandGeos: THREE.BufferGeometry[] = []
      const shallowGeos: THREE.BufferGeometry[] = []

      // Per-site rim wiggle, regenerated deterministically from ctx.rand().
      const buildSite = (site: Site) => {
        up.set(site.dir[0], site.dir[1], site.dir[2]).normalize()
        // tangent basis around `up`
        tanA.set(0, 1, 0)
        if (Math.abs(up.y) > 0.95) tanA.set(1, 0, 0)
        tanA.crossVectors(up, tanA).normalize()
        tanB.crossVectors(up, tanA).normalize()
        baseQuat.setFromUnitVectors(UP_Y, up)
        const origin = up.clone().multiplyScalar(R)

        siteFrames.push({
          up: up.clone(),
          tanA: tanA.clone(),
          tanB: tanB.clone(),
          origin,
          baseQuat: baseQuat.clone(),
        })

        // Coastline wiggle for this site (shared by land + coast rings).
        const rim = new Float32Array(LAND_SEGS)
        for (let s = 0; s < LAND_SEGS; s++) rim[s] = rand()

        // 1) LANDMASS dome (local frame, +Y up). Seated so its rim (y=0) meets
        //    the crust: we offset the whole group along `up` by 0 (rim at R).
        const shore = site.biome === 'snow' ? SHORE_ICE : SAND
        const land = buildLandmass(site.radius, LAND_COLOR[site.biome], shore, rim)
        // curve onto the sphere, then bake the site transform into the geometry.
        spherify(land, R)
        applyFrame(land, up, tanA, tanB, origin)
        landByBiome[site.biome].push(land)

        // 2) COAST: sand rim at the waterline (y just above the crust) ...
        const sand = buildRing(0.88, COAST_SAND_W, 0.18 * S, SAND, rim, site.radius)
        spherify(sand, R)
        applyFrame(sand, up, tanA, tanB, origin)
        sandGeos.push(sand)
        // ... + a thin translucent shallow-water ring just outside the sand.
        const shallow = buildRing(1.0, SHALLOW_W, 0.1 * S, SHALLOW, rim, site.radius + COAST_SAND_W)
        spherify(shallow, R)
        applyFrame(shallow, up, tanA, tanB, origin)
        shallowGeos.push(shallow)
      }

      for (const site of SITES) buildSite(site)

      // ── Merge + add the static land / coast families ─────────────────────────
      const landMat = () =>
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          flatShading: true,
          roughness: 0.95,
          metalness: 0,
        })
      for (const biome of Object.keys(landByBiome) as Biome[]) {
        const list = landByBiome[biome]
        if (list.length === 0) continue
        const merged = mergeFlat(list)
        for (const g of list) g.dispose()
        if (!merged) continue
        merged.computeVertexNormals()
        const m = landMat()
        materials.push(m)
        geometries.push(merged)
        const mesh = new THREE.Mesh(merged, m)
        mesh.name = `landscape.land.${biome}`
        root.add(mesh)
        staticMeshes.push(mesh)
      }
      // coast sand (opaque)
      {
        const merged = mergeFlat(sandGeos)
        for (const g of sandGeos) g.dispose()
        if (merged) {
          merged.computeVertexNormals()
          const m = new THREE.MeshStandardMaterial({
            vertexColors: true,
            flatShading: true,
            roughness: 1,
            metalness: 0,
            side: THREE.DoubleSide,
          })
          materials.push(m)
          geometries.push(merged)
          const mesh = new THREE.Mesh(merged, m)
          mesh.name = 'landscape.coast.sand'
          root.add(mesh)
          staticMeshes.push(mesh)
        }
      }
      // shallow water (translucent pale turquoise)
      {
        const merged = mergeFlat(shallowGeos)
        for (const g of shallowGeos) g.dispose()
        if (merged) {
          merged.computeVertexNormals()
          const m = new THREE.MeshStandardMaterial({
            vertexColors: true,
            flatShading: true,
            roughness: 0.4,
            metalness: 0,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
            depthWrite: false,
          })
          materials.push(m)
          geometries.push(merged)
          const mesh = new THREE.Mesh(merged, m)
          mesh.name = 'landscape.coast.shallow'
          mesh.renderOrder = 1
          root.add(mesh)
          staticMeshes.push(mesh)
        }
      }

      // ── Build the shared prop InstancedMeshes (one per prop type) ────────────
      const geo: Record<keyof typeof CAP, THREE.BufferGeometry> = {
        pine: buildPine(false),
        round: buildRound(),
        bush: buildBush(),
        flower: buildFlower(),
        rock: buildRock(false),
        cactus: buildCactus(),
        palm: buildPalm(),
        boat: buildBoat(),
      }
      // Snow pines reuse the pine slot but with a snow-dusted variant geometry:
      // we keep ONE pine mesh and just bias colour by biome at build via a second
      // geometry is overkill — instead snow sites use the same pine geo (canopy
      // already light at altitude); a dedicated snowy rock keeps snow legible.
      const snowPine = buildPine(true)
      const sandRock = buildRock(true)
      for (const g of Object.values(geo)) geometries.push(g)
      geometries.push(snowPine, sandRock)

      const inst: Record<keyof typeof CAP, THREE.InstancedMesh> = {
        pine: makeInstanced(geo.pine, 'landscape.pines', CAP.pine, false, materials),
        round: makeInstanced(geo.round, 'landscape.round', CAP.round, false, materials),
        bush: makeInstanced(geo.bush, 'landscape.bushes', CAP.bush, false, materials),
        flower: makeInstanced(geo.flower, 'landscape.flowers', CAP.flower, true, materials),
        rock: makeInstanced(geo.rock, 'landscape.rocks', CAP.rock, false, materials),
        cactus: makeInstanced(geo.cactus, 'landscape.cacti', CAP.cactus, false, materials),
        palm: makeInstanced(geo.palm, 'landscape.palms', CAP.palm, true, materials),
        boat: makeInstanced(geo.boat, 'landscape.boats', CAP.boat, true, materials),
      }
      // separate snow-pine + sand-rock instanced meshes (still few draws total)
      const snowPineMesh = makeInstanced(snowPine, 'landscape.snowPines', CAP.pine, false, materials)
      const sandRockMesh = makeInstanced(sandRock, 'landscape.sandRocks', CAP.rock, false, materials)

      const counters: Record<string, number> = {}
      const swayerFor: Partial<Record<string, Swayer>> = {}
      const allInstanced: THREE.InstancedMesh[] = [
        ...Object.values(inst),
        snowPineMesh,
        sandRockMesh,
      ]
      for (const m of allInstanced) {
        counters[m.name] = 0
        root.add(m)
        propMeshes.push(m)
      }
      // create swayers for the leafy families (by mesh name)
      const newSwayer = (mesh: THREE.InstancedMesh, max: number, amp: number): Swayer => {
        const s: Swayer = {
          mesh,
          basePos: new Float32Array(max * 3),
          baseQuat: new Float32Array(max * 4),
          scale: new Float32Array(max),
          normal: new Float32Array(max * 3),
          phase: new Float32Array(max),
          amp,
          used: 0,
          cursor: 0,
        }
        swayers.push(s)
        return s
      }
      swayerFor[inst.pine.name] = newSwayer(inst.pine, CAP.pine, SWAY_AMP.pine!)
      swayerFor[inst.round.name] = newSwayer(inst.round, CAP.round, SWAY_AMP.round!)
      swayerFor[inst.bush.name] = newSwayer(inst.bush, CAP.bush, SWAY_AMP.bush!)
      swayerFor[inst.flower.name] = newSwayer(inst.flower, CAP.flower, SWAY_AMP.flower!)
      swayerFor[snowPineMesh.name] = newSwayer(snowPineMesh, CAP.pine, SWAY_AMP.pine!)
      swayerFor[inst.palm.name] = newSwayer(inst.palm, CAP.palm, SWAY_AMP.palm!)

      // Resolve which instanced mesh a (planKey, biome) pair writes into.
      const meshForPlan = (key: keyof typeof CAP, biome: Biome): THREE.InstancedMesh => {
        if (key === 'pine' && biome === 'snow') return snowPineMesh
        if (key === 'rock' && biome === 'desert') return sandRockMesh
        return inst[key]
      }

      // Place one prop instance at local-disc coords (radial fr, angle a) on a site.
      const placeProp = (
        frameIdx: number,
        key: keyof typeof CAP,
        biome: Biome,
        site: Site,
        opts?: { frMin?: number; frMax?: number; onWater?: boolean }
      ): boolean => {
        const f = siteFrames[frameIdx]
        const mesh = meshForPlan(key, biome)
        const cur = counters[mesh.name]
        if (cur >= mesh.instanceMatrix.count) return false

        // Default: sqrt → uniform area density inside the disc (clear central pad).
        // A coastal band (frMin..frMax) overrides this for shore props / water boats.
        let fr: number
        if (opts && opts.frMin !== undefined && opts.frMax !== undefined) {
          fr = opts.frMin + rand() * (opts.frMax - opts.frMin)
        } else {
          fr = CLEAR_FRAC + Math.sqrt(rand()) * (0.92 - CLEAR_FRAC)
        }
        const ang = rand() * Math.PI * 2
        const rr = site.radius * fr
        // Land props ride the dome crown; boats float on the blue crust (640).
        const h = opts && opts.onWater ? FLAT_CORE_GAP : LAND_HEIGHT * Math.cos((fr * Math.PI) / 2)

        // tangent offset → re-projected onto the curved dome (radius R + dome h),
        // matching spherify() so props sit ON the curved land, not a flat plane.
        lp.copy(f.tanA)
          .multiplyScalar(Math.cos(ang) * rr)
          .addScaledVector(f.tanB, Math.sin(ang) * rr)
        wp.copy(f.origin).add(lp).normalize().multiplyScalar(R + h)
        // outward normal of the dome ≈ planet radial (gentle dome → near-radial)
        wnormal.copy(wp).normalize()

        // orient: local +Y → surface normal, random yaw about it.
        quat.setFromUnitVectors(UP_Y, wnormal)
        spin.setFromAxisAngle(yAxis.set(0, 1, 0), rand() * Math.PI * 2)
        baseQuat.copy(quat).multiply(spin)

        const sr = SCALE[key]
        const s = sr[0] + rand() * (sr[1] - sr[0])
        scaleVec.setScalar(s)
        matrix.compose(wp, baseQuat, scaleVec)
        mesh.setMatrixAt(cur, matrix)

        const sway = swayerFor[mesh.name]
        if (sway) {
          const k3 = cur * 3
          const k4 = cur * 4
          sway.basePos[k3] = wp.x
          sway.basePos[k3 + 1] = wp.y
          sway.basePos[k3 + 2] = wp.z
          sway.baseQuat[k4] = baseQuat.x
          sway.baseQuat[k4 + 1] = baseQuat.y
          sway.baseQuat[k4 + 2] = baseQuat.z
          sway.baseQuat[k4 + 3] = baseQuat.w
          sway.scale[cur] = s
          sway.normal[k3] = wnormal.x
          sway.normal[k3 + 1] = wnormal.y
          sway.normal[k3 + 2] = wnormal.z
          sway.phase[cur] = rand() * Math.PI * 2
          sway.used = cur + 1
        }
        counters[mesh.name] = cur + 1
        return true
      }

      // ── Scatter vegetation per site, per prop plan ───────────────────────────
      SITES.forEach((site, i) => {
        // density scales with landmass radius (props ∝ radius for even cover)
        for (const plan of PLANS) {
          const per = plan.perRadius[site.biome]
          if (per <= 0) continue
          const target = Math.round(per * (site.radius / S))
          for (let n = 0; n < target; n++) {
            if (!placeProp(i, plan.key, site.biome, site)) break
          }
        }
      })

      // ── Coastal pass: palms + beach rocks along the shore, boats on the water ─
      SITES.forEach((site, i) => {
        const perR = site.radius / S
        // palms hug the sandy beach band (skip snow shores)
        const palms = site.biome === 'snow' ? 0 : Math.round(0.55 * perR)
        for (let n = 0; n < palms; n++) {
          if (!placeProp(i, 'palm', site.biome, site, { frMin: 0.6, frMax: 0.8 })) break
        }
        // extra rocks scattered right along the waterline
        const beachRocks = Math.round(0.4 * perR)
        for (let n = 0; n < beachRocks; n++) {
          if (!placeProp(i, 'rock', site.biome, site, { frMin: 0.66, frMax: 0.84 })) break
        }
        // sailboats moored on the water just off the island
        const boats = site.hasTown ? 6 : 3
        for (let n = 0; n < boats; n++) {
          if (!placeProp(i, 'boat', site.biome, site, { onWater: true, frMin: 1.05, frMax: 1.35 })) break
        }
      })

      // finalize: set counts + bounding spheres covering the whole planet.
      for (const m of allInstanced) {
        m.count = counters[m.name]
        m.instanceMatrix.needsUpdate = true
        m.computeBoundingSphere()
        if (m.boundingSphere) {
          m.boundingSphere.center.set(0, 0, 0)
          m.boundingSphere.radius = R * 1.3
        }
      }

      ctx.scene.add(root)
    },

    // Gentle, budgeted vegetation sway — rewrite a rolling slice of leafy
    // instance matrices each frame. Allocation-free (module-scope temps).
    update(dt: number, ctx: GameContext) {
      if (swayers.length === 0) return
      const t = ctx.elapsed()
      const gust = 0.6 + 0.4 * Math.sin(t * 0.5)
      const BUDGET = 320
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
      root.parent?.remove(root)
      for (const m of propMeshes) m.dispose()
      propMeshes.length = 0
      staticMeshes.length = 0
      for (const g of geometries) g.dispose()
      geometries.length = 0
      for (const mt of materials) mt.dispose()
      materials.length = 0
      swayers.length = 0
    },
  }
}

// ── Bake a site's tangent-frame transform into a local geometry's positions ────
// (so many sites of the same biome can be merged into one static mesh).
const _bf = new THREE.Vector3()
function applyFrame(
  geo: THREE.BufferGeometry,
  up: THREE.Vector3,
  tanA: THREE.Vector3,
  tanB: THREE.Vector3,
  origin: THREE.Vector3
): void {
  const pos = geo.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i)
    const ly = pos.getY(i)
    const lz = pos.getZ(i)
    // world = origin + lx·tanA + ly·up + lz·tanB
    _bf.copy(origin)
      .addScaledVector(tanA, lx)
      .addScaledVector(up, ly)
      .addScaledVector(tanB, lz)
    pos.setXYZ(i, _bf.x, _bf.y, _bf.z)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()
}

// ── Wind application — allocation-free; reuses module-scope temps. ─────────────
const _wPos = new THREE.Vector3()
const _wQuat = new THREE.Quaternion()
const _wBase = new THREE.Quaternion()
const _wTilt = new THREE.Quaternion()
const _wAxis = new THREE.Vector3()
const _wScale = new THREE.Vector3()
const _wMat = new THREE.Matrix4()
const _wTangent = new THREE.Vector3()
const _wHelper = new THREE.Vector3(0, 1, 0)

function applySway(s: Swayer, i: number, time: number, lean: number): void {
  const k3 = i * 3
  const k4 = i * 4
  _wPos.set(s.basePos[k3], s.basePos[k3 + 1], s.basePos[k3 + 2])
  _wBase.set(s.baseQuat[k4], s.baseQuat[k4 + 1], s.baseQuat[k4 + 2], s.baseQuat[k4 + 3])
  _wAxis.set(s.normal[k3], s.normal[k3 + 1], s.normal[k3 + 2])
  _wHelper.set(0, 1, 0)
  if (Math.abs(_wAxis.y) > 0.95) _wHelper.set(1, 0, 0)
  _wTangent.crossVectors(_wAxis, _wHelper).normalize()
  const ang = Math.sin(time * 1.6 + s.phase[i]) * lean
  _wTilt.setFromAxisAngle(_wTangent, ang)
  _wQuat.copy(_wTilt).multiply(_wBase)
  _wScale.setScalar(s.scale[i])
  _wMat.compose(_wPos, _wQuat, _wScale)
  s.mesh.setMatrixAt(i, _wMat)
}
