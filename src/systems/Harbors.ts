import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { GameContext, GameSystem } from '../core/types'
import { WORLD_SCALE } from '../world/WorldConfig'
import { FLAT_CORE_GAP } from '../world/Planet'
import { SITES, LAND_HEIGHT } from '../world/Sites'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Harbors
//
// Coastal / harbor GRAPHICS for the town islands. For every SITES site with
// hasTown === true we build a per-site harbor group, anchored exactly like the
// pinned lighthouse: oriented to the local surface normal (+Y = outward), seated
// on the island HILLTOP shell and reaching DOWN to the water with piers.
//
// World geometry (matched to Placements / Landscape):
//   • Hilltop shell  R_top   = planet.radius − FLAT_CORE_GAP + LAND_HEIGHT  (props
//     ride here — same level the towns sit on).
//   • Water surface  R_water = planet.radius (the blue crust, 640) — pier mouths,
//     bollards-in-water and the moored-boat band live out here.
// Piers span from the shore (just inside the island edge, hilltop level) OUT and
// DOWN to the water radius toward the boats moored by Landscape, so the planks
// physically connect the green hill to the blue sea.
//
// Contents per harbor:
//   • 1–3 plank-on-stilt PIERS reaching out over the water (curved to the sphere).
//   • A couple of gable WAREHOUSES + a simple jib CRANE on the quay.
//   • Mooring BOLLARDS / posts (some on the pier, some standing in the water).
//   • Stacked CRATES and BARRELS near the quay.
//   • A short banded COASTAL LIGHTHOUSE on a point of one-or-two of the harbors
//     (the look reused from Placements.buildLighthouse, shrunk further).
//
// HARD CLEARANCE: the plane cruises at radius+64 = 704. Everything here tops out
// well under ~40u over the crust (tallest = the harbor lighthouse, ≈ 26u over the
// hilltop, ≈ 40u over the crust — still below the 686 ceiling). Most props < 12u.
//
// Performance: warm earthy palette, low-poly flat-shaded MeshStandardMaterial for
// solids, emissive MeshBasicMaterial (toneMapped:false, HDR) for the lamp so it
// BLOOMs. Geometry is MERGED per material family across all harbors → a handful of
// draw calls total. update() does a gentle, zero-allocation buoy/crane sway and a
// rotating lighthouse beam. dispose() frees everything.
// ─────────────────────────────────────────────────────────────────────────────

const S = WORLD_SCALE
const UP_Y = new THREE.Vector3(0, 1, 0)
const col = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

// Warm, earthy harbor palette (authored sRGB, colour-managed like PAL).
const HCOL = {
  plank: 0x9c764e, // sun-bleached deck planks
  plankDark: 0x7c5a39, // shaded under-planks / cross-beams
  stilt: 0x6f4f34, // dark wet pilings
  bollard: 0x5b4630, // mooring posts
  warehouseA: 0xcaa46e, // timber shed walls
  warehouseB: 0xbf9461,
  roofA: 0x8c5a4a, // weathered red roof
  roofB: 0x5f7d76, // teal-grey roof
  crane: 0x7e7164, // steel-grey jib
  craneTrim: 0xc77a3a, // rusty orange accents
  crate: 0xb98a55, // crate timber
  crateDark: 0x9a6f41,
  barrel: 0x8a5a36,
  barrelBand: 0x5a4128,
  ropeRing: 0x3a2f22,
  lhWhite: 0xf2eee6,
  lhRed: 0xd64a3f,
  lhBase: 0x9a8f86,
  lhCap: 0x3a3a44,
} as const

const LAMP_HDR = new THREE.Color(2.6, 1.9, 0.9) // warm HDR → blooms in the composer

// ── tiny geometry helpers (build-time only) ──────────────────────────────────
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

function mergeFlat(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (list.length === 0) return null
  const merged = mergeGeometries(
    list.map((g) => (g.index ? g.toNonIndexed() : g)),
    false
  )
  if (merged) merged.computeVertexNormals()
  return merged
}

// A vertex-coloured box at (x,y,z) with size (w,h,d), optional Y-rotation.
function vbox(
  out: THREE.BufferGeometry[],
  color: THREE.Color,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  ry = 0
): void {
  const g = new THREE.BoxGeometry(w, h, d)
  if (ry) g.rotateY(ry)
  g.translate(x, y, z)
  paint(g, color)
  out.push(g)
}

// A vertex-coloured cylinder (default upright) at (x,y,z).
function vcyl(
  out: THREE.BufferGeometry[],
  color: THREE.Color,
  x: number,
  y: number,
  z: number,
  rt: number,
  rb: number,
  h: number,
  radial: number,
  rot?: [number, number, number]
): void {
  const g = new THREE.CylinderGeometry(rt, rb, h, radial)
  if (rot) {
    g.rotateX(rot[0])
    g.rotateY(rot[1])
    g.rotateZ(rot[2])
  }
  g.translate(x, y, z)
  paint(g, color)
  out.push(g)
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-harbor builder — accumulates geometry (in the LOCAL site tangent frame,
// +Y radial-out, origin at the HILLTOP shell R_top) into per-material buckets so
// every harbor on the planet merges down to a few draw calls.
//
// LOCAL HEIGHT CONVENTION (subtle but important):
//   y = 0 is the HILLTOP shell (R_top). The water sits R_drop = (LAND_HEIGHT)
//   BELOW the hilltop in straight-radial terms (water at R_water = R_top −
//   LAND_HEIGHT). So a pier walking "down to the water" ramps from y≈0 at the
//   shore to y≈−LAND_HEIGHT at its seaward mouth. We curve nothing by hand — the
//   site frame is a flat tangent plane and the harbor footprint (≤ ~110u across)
//   is tiny vs the 640 globe, so a straight local frame reads fine, exactly as
//   Placements does for its towns.
// ─────────────────────────────────────────────────────────────────────────────

type Rand = () => number

interface HarborBuckets {
  plank: THREE.BufferGeometry[]
  plankDark: THREE.BufferGeometry[]
  stilt: THREE.BufferGeometry[]
  warehouseA: THREE.BufferGeometry[]
  warehouseB: THREE.BufferGeometry[]
  roofA: THREE.BufferGeometry[]
  roofB: THREE.BufferGeometry[]
  crane: THREE.BufferGeometry[]
  craneTrim: THREE.BufferGeometry[]
  crate: THREE.BufferGeometry[]
  crateDark: THREE.BufferGeometry[]
  barrel: THREE.BufferGeometry[]
  barrelBand: THREE.BufferGeometry[]
  bollard: THREE.BufferGeometry[]
  ropeRing: THREE.BufferGeometry[]
  lhWhite: THREE.BufferGeometry[]
  lhRed: THREE.BufferGeometry[]
  lhBase: THREE.BufferGeometry[]
  lhCap: THREE.BufferGeometry[]
}

// A dynamic lamp glow we keep as its own Mesh (so it blooms + can pulse).
interface LampNode {
  mesh: THREE.Mesh
  beamPivot: THREE.Object3D
}

// One plank-on-stilt pier ramping from the shore (y≈0) out to the water.
// dir2 is the in-plane outward heading (unit, in local X/Z).
function buildPier(
  b: HarborBuckets,
  rand: Rand,
  startR: number, // radial distance from site centre at the shore end
  outLen: number, // how far further out the pier reaches
  dropToWater: number, // how far DOWN (local −Y) the seaward mouth sits
  heading: number, // angle in the local X/Z plane
  deckW: number
): void {
  const dx = Math.cos(heading)
  const dz = Math.sin(heading)
  const nx = -dz // perpendicular (for stilt pairs / rails)
  const nz = dx
  const COL_plank = col(HCOL.plank)
  const COL_dark = col(HCOL.plankDark)
  const COL_stilt = col(HCOL.stilt)

  const spans = 5 + ((rand() * 3) | 0) // plank segments along the pier
  const deckTop = 0.55 * S // thin deck just above the local frame line
  const plankH = 0.22 * S
  for (let i = 0; i <= spans; i++) {
    const t = i / spans
    const r = startR + t * outLen
    const y = -t * dropToWater + deckTop // ramp down toward the water
    const cx = dx * r
    const cz = dz * r
    if (i < spans) {
      // a deck plank segment spanning to the next post
      const r2 = startR + ((i + 1) / spans) * outLen
      const segLen = Math.hypot((dx * r2 - cx), (dz * r2 - cz)) + 0.05 * S
      const mx = dx * (r + r2) * 0.5
      const mz = dz * (r + r2) * 0.5
      const y2 = -((i + 0.5) / spans) * dropToWater + deckTop
      vbox(b.plank, COL_plank, mx, y2, mz, deckW, plankH, segLen, heading)
      // a darker cross-beam under the deck
      vbox(b.plankDark, COL_dark, mx, y2 - plankH, mz, deckW * 1.04, 0.16 * S, 0.5 * S, heading)
    }
    // stilt pair plunging down into the water (length grows toward the sea end)
    const stiltLen = (1.4 + t * (dropToWater / S + 1.2)) * S
    for (const s of [-1, 1]) {
      const sx = cx + nx * deckW * 0.42 * s
      const sz = cz + nz * deckW * 0.42 * s
      vcyl(b.stilt, COL_stilt, sx, y - stiltLen * 0.5, sz, 0.12 * S, 0.16 * S, stiltLen, 6)
    }
    // low rail posts every other span (keeps it readable, low-poly)
    if (i % 2 === 0 && i < spans) {
      for (const s of [-1, 1]) {
        const rx = cx + nx * deckW * 0.46 * s
        const rz = cz + nz * deckW * 0.46 * s
        vcyl(b.plankDark, COL_dark, rx, y + 0.5 * S, rz, 0.07 * S, 0.07 * S, 1.0 * S, 5)
      }
    }
  }
}

// A gable warehouse (timber shed) — walls + pitched roof. ~10u tall.
function buildWarehouse(b: HarborBuckets, rand: Rand, x: number, z: number, ry: number): void {
  const wallHex = rand() < 0.5 ? HCOL.warehouseA : HCOL.warehouseB
  const wallBucket = wallHex === HCOL.warehouseA ? b.warehouseA : b.warehouseB
  const roofHex = rand() < 0.5 ? HCOL.roofA : HCOL.roofB
  const roofBucket = roofHex === HCOL.roofA ? b.roofA : b.roofB
  const w = (5 + rand() * 2.5) * S * 0.55
  const d = (6.5 + rand() * 3) * S * 0.55
  const wallH = (4.5 + rand() * 1.5) * S * 0.55
  vbox(wallBucket, col(wallHex), x, wallH * 0.5, z, w, wallH, d, ry)
  // pitched gable roof: a 4-sided cone (triangular prism), scaled along the ridge
  const roofH = 2.4 * S * 0.55
  const g = new THREE.CylinderGeometry(0.001, w * 0.74, roofH, 4)
  g.scale(1, 1, (d * 1.06) / (w * 0.74 * 1.6))
  g.rotateY(Math.PI / 4)
  g.rotateY(ry)
  g.translate(x, wallH + roofH * 0.5, z)
  paint(g, col(roofHex))
  roofBucket.push(g)
  // big sliding cargo door (dark plank) on the +local-Z face
  const dx = Math.sin(ry) * (d * 0.5 + 0.05 * S)
  const dz = Math.cos(ry) * (d * 0.5 + 0.05 * S)
  vbox(b.plankDark, col(HCOL.plankDark), x + dx, wallH * 0.42, z + dz, w * 0.5, wallH * 0.72, 0.25 * S, ry)
}

// A simple jib crane on the quay: a post, a horizontal jib arm + a hanging hook.
// Returns the jib pivot so update() can swing it gently. ~12u tall.
function buildCrane(b: HarborBuckets, x: number, z: number): THREE.Group {
  const COL_steel = col(HCOL.crane)
  const COL_trim = col(HCOL.craneTrim)
  // static mast + base added to merged buckets (no animation on these)
  vbox(b.crane, COL_steel, x, 0.3 * S, z, 2.2 * S, 0.6 * S, 2.2 * S) // base pad
  const mastH = 8.5 * S
  vcyl(b.crane, COL_steel, x, mastH * 0.5 + 0.6 * S, z, 0.32 * S, 0.42 * S, mastH, 8)
  // a couple of orange trim bands up the mast
  for (const ty of [0.35, 0.7]) {
    vcyl(b.craneTrim, COL_trim, x, 0.6 * S + mastH * ty, z, 0.46 * S, 0.46 * S, 0.5 * S, 8)
  }
  // the swinging jib is its OWN group (kept out of the merged buckets) so it can
  // rotate in update(). Built around a local pivot at the mast top.
  const pivot = new THREE.Group()
  pivot.position.set(x, 0.6 * S + mastH, z)
  const jibLen = 6.5 * S
  const jibMat = new THREE.MeshStandardMaterial({
    color: COL_trim,
    flatShading: true,
    roughness: 0.7,
    metalness: 0.2,
  })
  const jibGeo = new THREE.BoxGeometry(jibLen, 0.4 * S, 0.4 * S)
  jibGeo.translate(jibLen * 0.5 - 0.6 * S, 0, 0)
  const jib = new THREE.Mesh(jibGeo, jibMat)
  pivot.add(jib)
  // counter-jib stub
  const cgeo = new THREE.BoxGeometry(2.0 * S, 0.4 * S, 0.4 * S)
  cgeo.translate(-1.4 * S, 0, 0)
  pivot.add(new THREE.Mesh(cgeo, jibMat))
  // hanging cable + hook block at the jib tip
  const cableGeo = new THREE.CylinderGeometry(0.05 * S, 0.05 * S, 3.0 * S, 4)
  cableGeo.translate(jibLen - 0.8 * S, -1.5 * S, 0)
  const cable = new THREE.Mesh(cableGeo, new THREE.MeshStandardMaterial({ color: col(HCOL.ropeRing), flatShading: true }))
  pivot.add(cable)
  const hookGeo = new THREE.BoxGeometry(0.6 * S, 0.7 * S, 0.6 * S)
  hookGeo.translate(jibLen - 0.8 * S, -3.2 * S, 0)
  pivot.add(new THREE.Mesh(hookGeo, jibMat))
  return pivot
}

// A stack of crates near the quay. ~4u tall.
function buildCrates(b: HarborBuckets, rand: Rand, x: number, z: number): void {
  const n = 2 + ((rand() * 4) | 0)
  for (let i = 0; i < n; i++) {
    const sz = (0.9 + rand() * 0.5) * S
    const cx = x + (rand() - 0.5) * 2.2 * S
    const cz = z + (rand() - 0.5) * 2.2 * S
    const stack = rand() < 0.4 ? 2 : 1
    for (let k = 0; k < stack; k++) {
      const bucket = (i + k) % 2 === 0 ? b.crate : b.crateDark
      const hex = (i + k) % 2 === 0 ? HCOL.crate : HCOL.crateDark
      vbox(bucket, col(hex), cx, sz * 0.5 + k * sz * 1.02, cz, sz, sz, sz, rand() * 0.6)
    }
  }
}

// A few barrels (banded casks) near the quay. ~3u tall.
function buildBarrels(b: HarborBuckets, rand: Rand, x: number, z: number): void {
  const n = 2 + ((rand() * 3) | 0)
  for (let i = 0; i < n; i++) {
    const r = 0.5 * S
    const h = 1.4 * S
    const bx = x + (rand() - 0.5) * 2.6 * S
    const bz = z + (rand() - 0.5) * 2.6 * S
    vcyl(b.barrel, col(HCOL.barrel), bx, h * 0.5, bz, r * 0.86, r, h, 8)
    vcyl(b.barrel, col(HCOL.barrel), bx, h * 0.5, bz, r, r * 0.86, h * 0.5, 8) // belly
    // two dark hoop bands
    for (const by of [0.28, 0.72]) {
      vcyl(b.barrelBand, col(HCOL.barrelBand), bx, h * by, bz, r * 1.02, r * 1.02, 0.12 * S, 8)
    }
  }
}

// A mooring bollard/post at (x,y,z) with a rope ring near the top. ~2u tall.
function buildBollard(b: HarborBuckets, x: number, y: number, z: number): void {
  const h = 1.8 * S
  vcyl(b.bollard, col(HCOL.bollard), x, y + h * 0.5, z, 0.26 * S, 0.32 * S, h, 7)
  vcyl(b.bollard, col(HCOL.bollard), x, y + h + 0.12 * S, z, 0.36 * S, 0.3 * S, 0.24 * S, 7) // mushroom cap
  // a rope ring (thin torus) around the neck
  const ring = new THREE.TorusGeometry(0.34 * S, 0.07 * S, 4, 8)
  ring.rotateX(Math.PI / 2)
  ring.translate(x, y + h * 0.6, z)
  paint(ring, col(HCOL.ropeRing))
  b.ropeRing.push(ring)
}

// A short banded coastal lighthouse on a harbor point. Reuses the Placements
// lighthouse look, shrunk. Returns the lamp/beam node for animation. ~24u tall.
function buildHarborLighthouse(b: HarborBuckets, x: number, z: number): LampNode {
  const COL_white = col(HCOL.lhWhite)
  const COL_red = col(HCOL.lhRed)
  // squat base
  vcyl(b.lhBase, col(HCOL.lhBase), x, 0.4 * S, z, 1.6 * S, 2.1 * S, 0.8 * S, 12)
  let y = 0.8 * S
  const bands = 5
  const bandH = 0.7 * S
  for (let i = 0; i < bands; i++) {
    const rB = THREE.MathUtils.lerp(1.4, 0.9, i / bands) * S
    const rT = THREE.MathUtils.lerp(1.4, 0.9, (i + 1) / bands) * S
    vcyl(i % 2 ? b.lhRed : b.lhWhite, i % 2 ? COL_red : COL_white, x, y + bandH * 0.5, z, rT, rB, bandH, 12)
    y += bandH
  }
  // gallery + roof
  vcyl(b.lhCap, col(HCOL.lhCap), x, y + 0.12 * S, z, 1.15 * S, 1.15 * S, 0.24 * S, 12)
  y += 0.24 * S
  const lampY = y + 0.45 * S
  const roof = new THREE.ConeGeometry(0.95 * S, 0.7 * S, 12)
  roof.translate(x, y + 0.9 * S, z)
  paint(roof, COL_red)
  b.lhRed.push(roof)

  // emissive lamp core (its own mesh so it BLOOMs)
  const lampGeo = new THREE.SphereGeometry(0.4 * S, 12, 8)
  const lampMat = new THREE.MeshBasicMaterial({ color: LAMP_HDR.clone(), toneMapped: false })
  const lamp = new THREE.Mesh(lampGeo, lampMat)
  lamp.position.set(x, lampY, z)

  // rotating sweep beam (a hollow cone widening outward from the lamp)
  const beamPivot = new THREE.Group()
  beamPivot.position.set(x, lampY, z)
  const beamLen = 9 * S
  const beamGeo = new THREE.ConeGeometry(1.0 * S, beamLen, 12, 1, true)
  beamGeo.rotateZ(Math.PI / 2)
  beamGeo.translate(beamLen / 2, 0, 0)
  const beam = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      color: col(0xfff1b0),
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
  )
  beamPivot.add(beam)
  // beamPivot sits at the lamp's local origin so it spins about the lamp in update
  beamPivot.position.set(0, 0, 0)
  lamp.add(beamPivot)
  lamp.userData.beam = beam
  return { mesh: lamp, beamPivot }
}

// ── floating buoy (its own mesh; bobs on the water) ───────────────────────────
function buildBuoy(): { mesh: THREE.Group; mat: THREE.Material[] } {
  const g = new THREE.Group()
  const buoyMat = new THREE.MeshStandardMaterial({ color: col(HCOL.lhRed), flatShading: true, roughness: 0.6 })
  const capMat = new THREE.MeshStandardMaterial({ color: col(HCOL.lhWhite), flatShading: true, roughness: 0.7 })
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.6 * S, 0.8 * S, 1.6 * S, 8), buoyMat)
  body.position.y = 0.8 * S
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.5 * S, 0.8 * S, 8), capMat)
  cap.position.y = 1.9 * S
  const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.4, 0.6), toneMapped: false })
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.22 * S, 8, 6), lightMat)
  light.position.y = 2.5 * S
  g.add(body, cap, light)
  return { mesh: g, mat: [buoyMat, capMat, lightMat] }
}

// ─────────────────────────────────────────────────────────────────────────────
export function createHarborsSystem(): GameSystem {
  const root = new THREE.Group()
  root.name = 'harbors'

  // merged static meshes + collected resources for disposal
  const staticMeshes: THREE.Mesh[] = []
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []

  // animated nodes (kept OUTSIDE the merge so they can move)
  interface CraneNode {
    pivot: THREE.Group
    base: number
    phase: number
  }
  interface BuoyNode {
    group: THREE.Group
    baseR: number
    phase: number
  }
  const lamps: LampNode[] = []
  const cranes: CraneNode[] = []
  const buoys: BuoyNode[] = []

  return {
    name: 'harbors',

    init(ctx: GameContext) {
      const rand = ctx.rand
      const R = ctx.planet.radius // water surface (blue crust, 640)
      const Rtop = ctx.planet.radius - FLAT_CORE_GAP + LAND_HEIGHT // island hilltop shell
      // straight-radial drop from the hilltop shell down to the water surface.
      const dropToWater = Rtop - R // ≈ LAND_HEIGHT − FLAT_CORE_GAP (positive)

      // material families shared across ALL harbors (vertex-coloured, so one mat
      // per family carries every tint; merged geometry → a handful of draws).
      const famMat = () =>
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          flatShading: true,
          roughness: 0.85,
          metalness: 0,
        })

      // count town sites so we can put a lighthouse on ~the first two harbors only
      let townIdx = 0

      for (let si = 0; si < SITES.length; si++) {
        const site = SITES[si]
        if (!site.hasTown) continue

        const up = new THREE.Vector3(site.dir[0], site.dir[1], site.dir[2]).normalize()
        // per-harbor group seated on the hilltop shell, oriented to the normal.
        const hg = new THREE.Group()
        hg.position.copy(up).multiplyScalar(Rtop)
        hg.quaternion.setFromUnitVectors(UP_Y, up)
        hg.name = `harbor.${site.name}`
        root.add(hg)

        // local per-harbor buckets so animated nodes can attach to THIS group,
        // while static geometry still feeds a per-harbor merge. We keep each
        // harbor's STATIC geometry in its own bucket set and merge per-group:
        // simpler than world-baking into one global mesh, still few draws (≤ ~5
        // harbors × a handful of non-empty families). Use a local bucket set:
        const LB: HarborBuckets = {
          plank: [], plankDark: [], stilt: [],
          warehouseA: [], warehouseB: [], roofA: [], roofB: [],
          crane: [], craneTrim: [], crate: [], crateDark: [],
          barrel: [], barrelBand: [], bollard: [], ropeRing: [],
          lhWhite: [], lhRed: [], lhBase: [], lhCap: [],
        }

        // shore radius: just inside the island edge (Landscape boats moor at
        // fr≈1.05..1.35 of site.radius on the water). Quay sits at ~0.78·radius.
        const edge = site.radius
        const quayR = edge * 0.72

        // ── PIERS: 1..3 reaching from the quay OUT past the island edge to the
        //    water, toward the moored boats. ────────────────────────────────────
        const nPiers = 1 + ((rand() * 3) | 0)
        const baseHeading = rand() * Math.PI * 2
        for (let p = 0; p < nPiers; p++) {
          const heading = baseHeading + (p - (nPiers - 1) / 2) * 0.5 + (rand() - 0.5) * 0.15
          const startR = quayR + (rand() - 0.5) * 4 * S
          const outLen = (edge - startR) + (8 + rand() * 10) * S // reach past the shore
          buildPier(LB, rand, startR, outLen, dropToWater + 0.5 * S, heading, (2.0 + rand() * 0.8) * S)
          // a mooring bollard out at the pier mouth (standing in the water)
          const mouthR = startR + outLen
          const bx = Math.cos(heading) * mouthR
          const bz = Math.sin(heading) * mouthR
          buildBollard(LB, bx, -dropToWater - 0.2 * S, bz)
          // a floating buoy a little beyond the pier mouth (animated)
          const buoy = buildBuoy()
          const buoyR = mouthR + (3 + rand() * 4) * S
          // buoy lives at the WATER radius → compute its own world up + place
          const bdx = Math.cos(heading) * buoyR
          const bdz = Math.sin(heading) * buoyR
          // seat the buoy at the water radius (local −dropToWater below the hilltop)
          buoy.mesh.position.set(bdx, -dropToWater, bdz)
          hg.add(buoy.mesh)
          for (const m of buoy.mat) materials.push(m)
          buoy.mesh.traverse((o) => {
            const mm = (o as THREE.Mesh).geometry
            if (mm) geometries.push(mm)
          })
          buoys.push({
            group: buoy.mesh,
            baseR: -dropToWater,
            phase: rand() * Math.PI * 2,
          })
        }

        // ── QUAY PROPS arranged around the shore arc nearest the piers ──────────
        const quayAng = baseHeading
        const qx = Math.cos(quayAng) * quayR
        const qz = Math.sin(quayAng) * quayR
        const tx = -Math.sin(quayAng) // tangent along the shore
        const tz = Math.cos(quayAng)

        // warehouses set back a touch from the waterline
        const nWare = 1 + ((rand() * 2) | 0)
        for (let w = 0; w < nWare; w++) {
          const off = (w - (nWare - 1) / 2) * 9 * S
          const back = (4 + rand() * 3) * S
          const wx = qx + tx * off - Math.cos(quayAng) * back
          const wz = qz + tz * off - Math.sin(quayAng) * back
          buildWarehouse(LB, rand, wx, wz, quayAng + Math.PI + (rand() - 0.5) * 0.3)
        }

        // a crane right on the quay edge (animated jib)
        {
          const cx = qx + tx * (-6 + rand() * 12) * S
          const cz = qz + tz * (-6 + rand() * 12) * S
          const pivot = buildCrane(LB, cx, cz)
          hg.add(pivot)
          cranes.push({ pivot, base: pivot.rotation.y, phase: rand() * Math.PI * 2 })
          pivot.traverse((o) => {
            const mesh = o as THREE.Mesh
            if (mesh.isMesh) {
              if (mesh.geometry) geometries.push(mesh.geometry)
              const mat = mesh.material
              if (Array.isArray(mat)) for (const m of mat) materials.push(m)
              else if (mat) materials.push(mat)
            }
          })
        }

        // crates + barrels clustered along the quay
        for (let c = 0; c < 2; c++) {
          const off = (rand() - 0.5) * 14 * S
          buildCrates(LB, rand, qx + tx * off, qz + tz * off)
        }
        for (let bsl = 0; bsl < 2; bsl++) {
          const off = (rand() - 0.5) * 14 * S
          buildBarrels(LB, rand, qx + tx * off, qz + tz * off)
        }

        // bollards lining the quay (on the hilltop, y≈0)
        const nBoll = 4 + ((rand() * 3) | 0)
        for (let i = 0; i < nBoll; i++) {
          const off = (i / (nBoll - 1) - 0.5) * 20 * S
          buildBollard(LB, qx + tx * off, 0.0, qz + tz * off)
        }

        // ── a short coastal LIGHTHOUSE on a point — only the first ~2 harbors ──
        if (townIdx < 2) {
          const lhAng = baseHeading + Math.PI * (0.55 + rand() * 0.4)
          const lhR = edge * (0.86 + rand() * 0.1)
          const lx = Math.cos(lhAng) * lhR
          const lz = Math.sin(lhAng) * lhR
          const lamp = buildHarborLighthouse(LB, lx, lz)
          hg.add(lamp.mesh)
          materials.push(lamp.mesh.material as THREE.Material)
          geometries.push(lamp.mesh.geometry)
          const beam = lamp.mesh.userData.beam as THREE.Mesh | undefined
          if (beam) {
            geometries.push(beam.geometry)
            materials.push(beam.material as THREE.Material)
          }
          lamps.push(lamp)
        }

        // ── merge THIS harbor's static families → one mesh per non-empty family ─
        const families: Array<[keyof HarborBuckets, number]> = [
          ['plank', HCOL.plank], ['plankDark', HCOL.plankDark], ['stilt', HCOL.stilt],
          ['warehouseA', HCOL.warehouseA], ['warehouseB', HCOL.warehouseB],
          ['roofA', HCOL.roofA], ['roofB', HCOL.roofB],
          ['crane', HCOL.crane], ['craneTrim', HCOL.craneTrim],
          ['crate', HCOL.crate], ['crateDark', HCOL.crateDark],
          ['barrel', HCOL.barrel], ['barrelBand', HCOL.barrelBand],
          ['bollard', HCOL.bollard], ['ropeRing', HCOL.ropeRing],
          ['lhWhite', HCOL.lhWhite], ['lhRed', HCOL.lhRed],
          ['lhBase', HCOL.lhBase], ['lhCap', HCOL.lhCap],
        ]
        for (const [fam] of families) {
          const list = LB[fam]
          if (list.length === 0) continue
          const merged = mergeFlat(list)
          for (const g of list) g.dispose()
          if (!merged) continue
          const m = famMat()
          const mesh = new THREE.Mesh(merged, m)
          mesh.name = `harbor.${site.name}.${fam}`
          hg.add(mesh)
          staticMeshes.push(mesh)
          geometries.push(merged)
          materials.push(m)
        }

        townIdx++
      }

      ctx.scene.add(root)
    },

    update(dt: number, ctx: GameContext) {
      const t = ctx.elapsed()
      // rotating lighthouse beams
      for (let i = 0; i < lamps.length; i++) {
        lamps[i].beamPivot.rotation.y += dt * 0.7
      }
      // gentle crane jib swing
      for (let i = 0; i < cranes.length; i++) {
        const c = cranes[i]
        c.pivot.rotation.y = c.base + Math.sin(t * 0.25 + c.phase) * 0.35
      }
      // buoy bob: ride the local radial axis up/down a touch + tiny tilt
      for (let i = 0; i < buoys.length; i++) {
        const bo = buoys[i]
        const bob = Math.sin(t * 1.3 + bo.phase) * 0.5 * S
        bo.group.position.y = bo.baseR + bob
        bo.group.rotation.x = Math.sin(t * 1.1 + bo.phase) * 0.06
        bo.group.rotation.z = Math.cos(t * 0.9 + bo.phase) * 0.06
      }
      void dt
    },

    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.geometry?.dispose()
          const mm = m.material
          if (Array.isArray(mm)) for (const x of mm) x.dispose()
          else mm?.dispose()
        }
      })
      for (const g of geometries) g.dispose()
      for (const m of materials) m.dispose()
      root.parent?.remove(root)
      root.clear()
      geometries.length = 0
      materials.length = 0
      staticMeshes.length = 0
      lamps.length = 0
      cranes.length = 0
      buoys.length = 0
    },
  }
}
