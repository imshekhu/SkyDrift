import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { alignToSurface } from '../world/surface'
import { WORLD_SCALE } from '../world/WorldConfig'
import type { BiomeKind, GameContext, GameSystem, RegionDef } from '../core/types'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Monuments
//
// Famous real-world monuments scattered across the planet's BIOME REGIONS. Each
// is authored as an external GLB asset (Meshy-generated later) loaded lazily at
// runtime; until the asset exists, a DISTINCT low-poly PROCEDURAL PLACEHOLDER
// stands in its place so the world is never empty. Everything stands PERPENDICULAR
// to the sphere via alignToSurface (local +Y → the radial surface normal), so the
// monument rises straight out of the planet on any slope instead of leaning toward
// global +Y.
//
// Placement plan: each monument prefers a region whose biome matches, else takes
// the next unused region capital round-robin (no region reused). Loading is fully
// async and never blocks init(); a failed/absent GLB resolves to NULL (never
// throws) and we fall back to the placeholder. update() is static (zero per-frame
// allocation).
// ─────────────────────────────────────────────────────────────────────────────

interface MonumentDef {
  id: string
  name: string
  /** resolved GLB url under the (GitHub-Pages) base path */
  url: string
  /** authored (radius-100) height; × WORLD_SCALE for the world height */
  targetHeight: number
  /** preferred biome region; falls back to round-robin if none free matches */
  biome?: BiomeKind
}

// BASE_URL works under the GitHub-Pages subpath (vite sets it; '.' locally). We
// read it through `(import.meta as any).env` to match main.ts and avoid needing
// the vite/client ambient types in this strict tsconfig.
const BASE_URL: string = ((import.meta as any).env?.BASE_URL as string | undefined) ?? './'
const url = (id: string): string => `${BASE_URL}monuments/${id}.glb`

// The registry. targetHeight is in AUTHORED units (multiply by WORLD_SCALE later).
const MONUMENTS: MonumentDef[] = [
  { id: 'eiffel-tower', name: 'Eiffel Tower', url: url('eiffel-tower'), targetHeight: 60, biome: 'meadow' },
  { id: 'taj-mahal', name: 'Taj Mahal', url: url('taj-mahal'), targetHeight: 38, biome: 'savanna' },
  { id: 'chichen-itza', name: 'Chichén Itzá', url: url('chichen-itza'), targetHeight: 30, biome: 'jungle' },
  { id: 'great-pyramids', name: 'Great Pyramids', url: url('great-pyramids'), targetHeight: 45, biome: 'desert' },
  { id: 'big-ben', name: 'Big Ben', url: url('big-ben'), targetHeight: 50, biome: 'forest' },
  { id: 'obelisk', name: 'The Obelisk', url: url('obelisk'), targetHeight: 42, biome: 'mesa' },
]

// One shared loader for the whole system.
const loader = new GLTFLoader()

/**
 * Load a GLB and resolve its scene as a THREE.Group, or NULL on ANY failure
 * (404, parse error, network). Never throws / never rejects — the caller decides
 * the fallback. Wraps the callback-style loader.load() in a Promise.
 */
function loadModel(modelUrl: string): Promise<THREE.Group | null> {
  return new Promise((resolve) => {
    try {
      loader.load(
        modelUrl,
        (gltf) => resolve(gltf.scene ?? null),
        undefined,
        () => resolve(null)
      )
    } catch {
      resolve(null)
    }
  })
}

// ── scale normalizer ─────────────────────────────────────────────────────────
const _box = new THREE.Box3()
const _size = new THREE.Vector3()

/**
 * Scale `model` uniformly so its bounding-box height equals `targetWorldHeight`,
 * then lift it so its BASE sits at local y=0 (feet at the wrapper origin — no
 * half-burying). Returns a wrapper Group whose +Y is "up out of the ground".
 */
function normalizeHeight(model: THREE.Object3D, targetWorldHeight: number): THREE.Group {
  _box.setFromObject(model)
  _box.getSize(_size)
  const height = _size.y
  const s = targetWorldHeight / Math.max(1e-3, height)
  model.scale.setScalar(s)
  // after scaling, the box min.y maps to min.y * s; offset so the base is at y=0
  model.position.y = -_box.min.y * s
  const wrapper = new THREE.Group()
  wrapper.add(model)
  return wrapper
}

// ── procedural placeholders ──────────────────────────────────────────────────
// Each placeholder reads as that monument's silhouette, built at the same
// targetWorldHeight so it occupies the same footprint as the real asset. Stone-ish
// flat-shaded standard material, tinted per monument. Geometries + materials are
// tracked per-build and disposed on teardown.

const srgb = (hex: number): THREE.Color => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)

interface BuildSink {
  geos: THREE.BufferGeometry[]
  mats: THREE.Material[]
}

function stoneMat(sink: BuildSink, color: THREE.Color): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.92, metalness: 0.02 })
  sink.mats.push(m)
  return m
}

function trackGeo<T extends THREE.BufferGeometry>(sink: BuildSink, g: T): T {
  sink.geos.push(g)
  return g
}

// Eiffel Tower — a tapered 4-leg lattice tower: stacked tapering box sections that
// narrow toward the top, four splayed legs at the base, capped by a thin spire.
function buildEiffel(sink: BuildSink, h: number, tint: THREE.Color): THREE.Group {
  const g = new THREE.Group()
  const iron = stoneMat(sink, tint)
  // four splayed legs forming the iconic arch-footed base (lower ~38% of height)
  const legH = h * 0.42
  const legGeo = trackGeo(sink, new THREE.BoxGeometry(h * 0.05, legH, h * 0.05))
  const spread = h * 0.2
  for (let k = 0; k < 4; k++) {
    const sx = k & 1 ? 1 : -1
    const sz = k & 2 ? 1 : -1
    const leg = new THREE.Mesh(legGeo, iron)
    leg.position.set((sx * spread) / 2, legH / 2, (sz * spread) / 2)
    // tilt each leg inward so they converge — the splayed-foot silhouette
    leg.rotation.z = -sx * 0.22
    leg.rotation.x = sz * 0.22
    g.add(leg)
  }
  // a broad platform where the legs meet
  const plat = trackGeo(sink, new THREE.BoxGeometry(h * 0.22, h * 0.03, h * 0.22))
  const mp = new THREE.Mesh(plat, iron)
  mp.position.y = legH
  g.add(mp)
  // tapering mid + upper sections (stacked shrinking boxes) to the spire
  let y = legH
  let w = h * 0.16
  const sections = 4
  const midTotal = h * 0.5
  for (let i = 0; i < sections; i++) {
    const segH = midTotal / sections
    const topW = w * 0.6
    const seg = trackGeo(sink, new THREE.CylinderGeometry(topW * 0.5, w * 0.5, segH, 4))
    const ms = new THREE.Mesh(seg, iron)
    ms.position.y = y + segH / 2
    ms.rotation.y = Math.PI / 4
    g.add(ms)
    y += segH
    w = topW
  }
  // thin spire on top
  const spire = trackGeo(sink, new THREE.ConeGeometry(w * 0.4, h * 0.08, 4))
  const msp = new THREE.Mesh(spire, iron)
  msp.position.y = y + h * 0.04
  msp.rotation.y = Math.PI / 4
  g.add(msp)
  return g
}

// Great Pyramids — a 4-sided ConeGeometry pyramid plus two smaller companions.
function buildPyramids(sink: BuildSink, h: number, tint: THREE.Color): THREE.Group {
  const g = new THREE.Group()
  const stone = stoneMat(sink, tint)
  const mk = (height: number, baseR: number, x: number, z: number) => {
    const geo = trackGeo(sink, new THREE.ConeGeometry(baseR, height, 4))
    const m = new THREE.Mesh(geo, stone)
    m.position.set(x, height / 2, z)
    m.rotation.y = Math.PI / 4 // square base faces axis-aligned
    g.add(m)
  }
  // base radius for a 4-sided cone ~ half-diagonal; pick so the great one reads big
  mk(h, h * 0.78, 0, 0)
  mk(h * 0.66, h * 0.52, -h * 0.95, h * 0.55)
  mk(h * 0.46, h * 0.36, h * 0.85, -h * 0.45)
  return g
}

// Taj Mahal — a domed cube: a box plinth + body, a SphereGeometry dome, four
// corner minaret cylinders, a small finial.
function buildTaj(sink: BuildSink, h: number, tint: THREE.Color): THREE.Group {
  const g = new THREE.Group()
  const marble = stoneMat(sink, tint)
  // wide low plinth
  const plinthH = h * 0.08
  const plinth = trackGeo(sink, new THREE.BoxGeometry(h * 1.1, plinthH, h * 1.1))
  const mpl = new THREE.Mesh(plinth, marble)
  mpl.position.y = plinthH / 2
  g.add(mpl)
  // main cubic body
  const bodyH = h * 0.46
  const body = trackGeo(sink, new THREE.BoxGeometry(h * 0.62, bodyH, h * 0.62))
  const mb = new THREE.Mesh(body, marble)
  mb.position.y = plinthH + bodyH / 2
  g.add(mb)
  // a chamfered drum under the dome
  const drumH = h * 0.1
  const drum = trackGeo(sink, new THREE.CylinderGeometry(h * 0.24, h * 0.28, drumH, 8))
  const md = new THREE.Mesh(drum, marble)
  md.position.y = plinthH + bodyH + drumH / 2
  g.add(md)
  // the onion dome — a sphere, base sitting on the drum
  const domeR = h * 0.26
  const domeGeo = trackGeo(sink, new THREE.SphereGeometry(domeR, 12, 10))
  const dome = new THREE.Mesh(domeGeo, marble)
  dome.position.y = plinthH + bodyH + drumH + domeR * 0.55
  dome.scale.y = 1.25 // give it the bulbous onion profile
  g.add(dome)
  // finial spike
  const finial = trackGeo(sink, new THREE.ConeGeometry(h * 0.03, h * 0.12, 6))
  const mf = new THREE.Mesh(finial, marble)
  mf.position.y = plinthH + bodyH + drumH + domeR * 1.6
  g.add(mf)
  // four corner minarets
  const minH = h * 0.72
  const minGeo = trackGeo(sink, new THREE.CylinderGeometry(h * 0.045, h * 0.055, minH, 8))
  const capGeo = trackGeo(sink, new THREE.ConeGeometry(h * 0.07, h * 0.1, 8))
  const off = h * 0.48
  for (let k = 0; k < 4; k++) {
    const sx = k & 1 ? 1 : -1
    const sz = k & 2 ? 1 : -1
    const min = new THREE.Mesh(minGeo, marble)
    min.position.set(sx * off, plinthH + minH / 2, sz * off)
    g.add(min)
    const cap = new THREE.Mesh(capGeo, marble)
    cap.position.set(sx * off, plinthH + minH + h * 0.05, sz * off)
    g.add(cap)
  }
  return g
}

// Chichén Itzá — a stepped pyramid: a few stacked shrinking boxes + a top temple.
function buildChichen(sink: BuildSink, h: number, tint: THREE.Color): THREE.Group {
  const g = new THREE.Group()
  const stone = stoneMat(sink, tint)
  const tiers = 5
  const tierH = (h * 0.82) / tiers
  let y = 0
  let w = h * 1.0
  for (let i = 0; i < tiers; i++) {
    const box = trackGeo(sink, new THREE.BoxGeometry(w, tierH, w))
    const m = new THREE.Mesh(box, stone)
    m.position.y = y + tierH / 2
    g.add(m)
    y += tierH
    w *= 0.8
  }
  // a central staircase ridge up the front face
  const stairW = h * 0.16
  const stair = trackGeo(sink, new THREE.BoxGeometry(stairW, h * 0.82, h * 0.12))
  const ms = new THREE.Mesh(stair, stone)
  ms.position.set(0, (h * 0.82) / 2, w * 1.4)
  ms.rotation.x = 0.0
  g.add(ms)
  // top temple
  const tH = h * 0.18
  const temple = trackGeo(sink, new THREE.BoxGeometry(w * 1.05, tH, w * 1.05))
  const mt = new THREE.Mesh(temple, stone)
  mt.position.y = y + tH / 2
  g.add(mt)
  // small roof comb on the temple
  const comb = trackGeo(sink, new THREE.BoxGeometry(w * 1.05, h * 0.05, w * 0.3))
  const mc = new THREE.Mesh(comb, stone)
  mc.position.y = y + tH + h * 0.025
  g.add(mc)
  return g
}

// Big Ben — a tall square clock tower: tapering shaft, a clock-face block, and a
// pointed spire roof.
function buildBigBen(sink: BuildSink, h: number, tint: THREE.Color): THREE.Group {
  const g = new THREE.Group()
  const stone = stoneMat(sink, tint)
  const face = stoneMat(sink, srgb(0xf3ead2))
  const shaftH = h * 0.7
  const shaft = trackGeo(sink, new THREE.BoxGeometry(h * 0.2, shaftH, h * 0.2))
  const ms = new THREE.Mesh(shaft, stone)
  ms.position.y = shaftH / 2
  g.add(ms)
  // clock-face block near the top
  const blockH = h * 0.14
  const block = trackGeo(sink, new THREE.BoxGeometry(h * 0.24, blockH, h * 0.24))
  const mb = new THREE.Mesh(block, stone)
  mb.position.y = shaftH + blockH / 2
  g.add(mb)
  // four clock faces
  const faceGeo = trackGeo(sink, new THREE.CircleGeometry(h * 0.07, 16))
  const off = h * 0.121
  const rots = [0, Math.PI / 2, Math.PI, -Math.PI / 2]
  for (let k = 0; k < 4; k++) {
    const f = new THREE.Mesh(faceGeo, face)
    const a = rots[k]
    f.position.set(Math.sin(a) * off, shaftH + blockH / 2, Math.cos(a) * off)
    f.rotation.y = a
    g.add(f)
  }
  // pyramidal spire roof
  const spireH = h * 0.18
  const spire = trackGeo(sink, new THREE.ConeGeometry(h * 0.17, spireH, 4))
  const msp = new THREE.Mesh(spire, stone)
  msp.position.y = shaftH + blockH + spireH / 2
  msp.rotation.y = Math.PI / 4
  g.add(msp)
  return g
}

// Obelisk — a tall four-sided tapering shaft capped by a pyramidion, on a plinth.
function buildObelisk(sink: BuildSink, h: number, tint: THREE.Color): THREE.Group {
  const g = new THREE.Group()
  const stone = stoneMat(sink, tint)
  const baseH = h * 0.08
  const base = trackGeo(sink, new THREE.BoxGeometry(h * 0.26, baseH, h * 0.26))
  const mbase = new THREE.Mesh(base, stone)
  mbase.position.y = baseH / 2
  g.add(mbase)
  const shaftH = h * 0.82
  // a 4-sided cylinder tapering slightly = clean obelisk shaft
  const shaft = trackGeo(sink, new THREE.CylinderGeometry(h * 0.05, h * 0.09, shaftH, 4))
  const ms = new THREE.Mesh(shaft, stone)
  ms.position.y = baseH + shaftH / 2
  ms.rotation.y = Math.PI / 4
  g.add(ms)
  // pyramidion cap
  const capH = h * 0.1
  const cap = trackGeo(sink, new THREE.ConeGeometry(h * 0.072, capH, 4))
  const mc = new THREE.Mesh(cap, stone)
  mc.position.y = baseH + shaftH + capH / 2
  mc.rotation.y = Math.PI / 4
  g.add(mc)
  return g
}

// Per-monument placeholder builder + tint. Falls back to a generic stepped block
// for any id without a dedicated builder (none today, but keeps it total).
const PLACEHOLDER_TINT: Record<string, number> = {
  'eiffel-tower': 0x8d6b4a,
  'taj-mahal': 0xeae6da,
  'chichen-itza': 0x9a8c6d,
  'great-pyramids': 0xd8c089,
  'big-ben': 0xb6a282,
  obelisk: 0xc9b48f,
}

function buildPlaceholder(def: MonumentDef, h: number, sink: BuildSink): THREE.Group {
  const tint = srgb(PLACEHOLDER_TINT[def.id] ?? 0xb8a98c)
  switch (def.id) {
    case 'eiffel-tower':
      return buildEiffel(sink, h, tint)
    case 'great-pyramids':
      return buildPyramids(sink, h, tint)
    case 'taj-mahal':
      return buildTaj(sink, h, tint)
    case 'chichen-itza':
      return buildChichen(sink, h, tint)
    case 'big-ben':
      return buildBigBen(sink, h, tint)
    case 'obelisk':
      return buildObelisk(sink, h, tint)
    default:
      // generic stepped monolith — still clearly a monument, not a bare cube
      return buildChichen(sink, h, tint)
  }
}

// ── placement planning ───────────────────────────────────────────────────────
interface PlacementPlan {
  def: MonumentDef
  capital: THREE.Vector3 // unit surface direction
  spin: number // random yaw about the surface normal, radians
}

/**
 * Build a placement plan: each monument prefers a free region whose biome matches,
 * else takes the next unused region capital (round-robin). No region is reused.
 * Returns null if regions are unavailable.
 */
function planPlacements(defs: RegionDef[], rand: () => number): PlacementPlan[] {
  const used = new Set<string>()
  const plans: PlacementPlan[] = []
  // round-robin cursor over regions for the fallback
  let cursor = 0
  const takeNextFree = (): RegionDef | null => {
    for (let n = 0; n < defs.length; n++) {
      const r = defs[(cursor + n) % defs.length]
      if (!used.has(r.id)) {
        cursor = (cursor + n + 1) % defs.length
        return r
      }
    }
    return null
  }
  for (const def of MONUMENTS) {
    let region: RegionDef | null = null
    if (def.biome) {
      region = defs.find((r) => r.biome === def.biome && !used.has(r.id)) ?? null
    }
    if (!region) region = takeNextFree()
    if (!region) break // no regions left — stop placing
    used.add(region.id)
    plans.push({
      def,
      capital: region.capital.clone().normalize(),
      spin: rand() * Math.PI * 2,
    })
  }
  return plans
}

// ── system ───────────────────────────────────────────────────────────────────
export function createMonumentSystem(): GameSystem {
  let group: THREE.Group | null = null
  const sink: BuildSink = { geos: [], mats: [] }
  // nodes added asynchronously; tracked for dispose()
  const nodes: THREE.Object3D[] = []
  // reusable temp for surface placement (zero-alloc per placement)
  const _pos = new THREE.Vector3()

  // Place a node at its capital: base tucked slightly into the ground, then aligned
  // perpendicular to the sphere (local +Y → radial normal) with a small yaw.
  const place = (node: THREE.Object3D, capital: THREE.Vector3, spin: number): void => {
    if (!group) return
    const sink2 = -2 * WORLD_SCALE // tuck the base in so it doesn't float on slopes
    const planet = currentPlanet
    if (planet) planet.surfacePoint(capital, sink2, _pos)
    node.position.copy(_pos)
    // CRITICAL: stand straight out of the planet, not tilted toward global +Y.
    alignToSurface(node, capital, spin)
    group.add(node)
    nodes.push(node)
  }

  // captured in init so the async .then() closures can place onto the surface
  let currentPlanet: GameContext['planet'] | null = null

  return {
    name: 'monuments',

    init(ctx: GameContext) {
      currentPlanet = ctx.planet
      group = new THREE.Group()
      group.name = 'monuments'
      ctx.scene.add(group)

      // regions are published by the Regions system at (ctx as any).regions.
      // MAY be undefined on the first frame — read lazily, guard, warn-at-most.
      const regions = (ctx as any).regions as { defs?: RegionDef[] } | undefined
      const defs = regions?.defs
      if (!defs || defs.length === 0) {
        console.warn('[Monuments] regions not available — monuments will not be placed')
        return
      }

      const plans = planPlacements(defs, ctx.rand)

      // Fire all loads WITHOUT blocking init. Each resolves to a real model or null.
      for (const plan of plans) {
        const h = plan.def.targetHeight * WORLD_SCALE
        loadModel(plan.def.url)
          .then((model) => {
            // guard: system may have been disposed before the load resolved
            if (!group) return
            const node = model ? normalizeHeight(model, h) : buildPlaceholder(plan.def, h, sink)
            place(node, plan.capital, plan.spin)
          })
          .catch(() => {
            // loadModel never rejects, but stay defensive — fall back to placeholder
            if (!group) return
            const node = buildPlaceholder(plan.def, h, sink)
            place(node, plan.capital, plan.spin)
          })
      }
    },

    // Static monuments: no per-frame work, zero allocation.
    update(_dt: number, _ctx: GameContext) {
      // intentionally empty — monuments are static scenery
    },

    dispose() {
      if (group) {
        group.parent?.remove(group)
        group = null
      }
      currentPlanet = null
      nodes.length = 0
      for (const g of sink.geos) g.dispose()
      for (const m of sink.mats) m.dispose()
      sink.geos.length = 0
      sink.mats.length = 0
    },
  }
}
