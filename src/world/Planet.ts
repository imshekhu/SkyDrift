import * as THREE from 'three'
import { createNoise3D } from 'simplex-noise'
import alea from 'alea'
import type { Planet, GameSystem, GameContext, RegionDef } from '../core/types'
import { PAL } from '../art/palette'
import { AUTHORED_RADIUS } from './WorldConfig'
import { regionInfluenceAt } from './regions'

// ─────────────────────────────────────────────────────────────────────────────
// SkyDrift — Planet
//
// A cozy low-poly pastel globe: an icosahedron displaced by FBM simplex noise,
// vertex-colored by elevation into water/sand/grass/forest/rock/snow bands, with
// a translucent inner water sphere that gently bobs. The SAME noise field powers
// both the displaced mesh AND heightAt(), so anything placed with surfacePoint()
// sits exactly on the terrain.
//
// POLISH PASS — richer biomes:
//   • Domain-warped coastlines so beaches wiggle organically instead of ringing.
//   • Sandy beaches that hug the true shoreline + a soft sub-water shoal.
//   • Snow caps that respect altitude AND latitude (poles get a frosting too).
//   • Subtle inland rivers/lakes carved by a separate low-freq moisture channel.
//   • Smoother coast→grass→forest→rock blending with hand-painted value jitter.
//   • Prettier translucent water: lighter foam near shores, two-band shimmer.
//
// buildPlanet() is NOT a GameSystem — main() calls it once to build ctx.planet.
// createPlanetWaterSystem() IS a GameSystem that animates the water bob.
// Zero per-frame allocation in update(); mobile-perf-conscious throughout.
// ─────────────────────────────────────────────────────────────────────────────

// --- terrain shaping (all relative to planet radius) -------------------------
const GEO_DETAIL = 7 // icosa subdivisions: ~980k tris — base tier (P3 adds high-detail region chunks)
const NOISE_FREQ = 1.5 // base spatial frequency of the FBM field
const FBM_OCTAVES = 4
const FBM_LACUNARITY = 2.0
const FBM_GAIN = 0.5
const RELIEF = 0.085 // max displacement as a fraction of radius
const SEA_LEVEL = 0.0 // elevation (in displacement units) below which is ocean
const WARP = 0.35 // domain-warp strength for organic, wiggly coastlines

// Water-band heights (fraction of radius). Inner sphere sits just below sea level
// so beaches read as a thin sand rim around the displaced land.
const WATER_INSET = 0.004 // inner water sphere sits this far below the mean radius

// Pastel biome ramp — authored as sRGB so AgX tone mapping behaves.
const sc = (hex: number) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace)
const BIOME = {
  waterDeep: sc(0x4f86c6),
  waterShallow: sc(0x7fb4e0),
  shoal: sc(0xb6dcec), // pale turquoise just under the shoreline
  sandWet: sc(0xd9b878), // damp sand — deepened so deserts/beaches read warm, not pale
  sand: sc(0xe6cb86), // dry sand — richer/warmer than the old near-cream so it pops vs the sky
  grass: PAL.planet.clone(), // cohesion: same green as PAL.planet
  meadow: sc(0xa6cf68), // richer lowland grass (deepened for biome contrast)
  forest: PAL.tree.clone(),
  rock: sc(0x9a8f86),
  rockDark: sc(0x7d756e), // shaded rock for craggy high slopes
  snow: sc(0xf4f0f7),
  river: sc(0x3fb8f0), // inland freshwater — bright, saturated blue-cyan so waterways read clearly vs land
}

// ── SMOOTH-SPHERE MODE (SKYDRIFT-MINIMAL) ─────────────────────────────────────
// true → no terrain displacement, no noise bumps, one solid colour, no water
// shell. heightAt() returns 0 everywhere, so flight's terrain-relative altitude
// collapses to a fixed, rock-steady cruise. Flip to false to restore the full
// FBM/biome/river/water planet — every original line is intact, just guarded.
const FLAT_PLANET = true
const FLAT_COLOR = sc(0x6fae5f) // pleasant solid green

// Elevation thresholds in NORMALIZED elevation space e∈[0,1] (0 = deepest, 1 = peak).
// Land starts at SHORE; below that is ocean floor (hidden under the water sphere).
const SHORE = 0.5
const SAND_TOP = 0.545
const GRASS_TOP = 0.66
const FOREST_TOP = 0.8
const ROCK_TOP = 0.92

export function buildPlanet(radius: number, rand: () => number, regions?: RegionDef[]): Planet {
  // Deterministic noise seeded from the game's RNG so the same seed → same world.
  const seed = Math.floor(rand() * 0xffffffff) >>> 0
  const noise3D = createNoise3D(alea(seed))
  // A second decorrelated field drives domain-warp + rivers (offset seed).
  const noiseWarp = createNoise3D(alea((seed ^ 0x9e3779b9) >>> 0))

  // FBM sampled on the UNIT sphere direction. Returns signed elevation in ~[-1,1]
  // before the RELIEF scale. Pulled out so heightAt() and the mesh agree exactly.
  // NOTE: closes over fixed module constants only — pure function of (x,y,z).
  const fbm = (x: number, y: number, z: number): number => {
    let amp = 1
    let freq = NOISE_FREQ
    let sum = 0
    let norm = 0
    for (let o = 0; o < FBM_OCTAVES; o++) {
      sum += amp * noise3D(x * freq, y * freq, z * freq)
      norm += amp
      amp *= FBM_GAIN
      freq *= FBM_LACUNARITY
    }
    return sum / norm // ∈ [-1, 1]
  }

  // Signed terrain elevation (in world units) above the base radius for a unit dir.
  // Continents are biased upward and oceans flattened a touch via a soft curve so
  // there's clear land vs. sea rather than uniform bumpiness. A low-freq domain
  // warp displaces the sample point so coastlines meander instead of ringing
  // around the noise lattice — cheap (one extra field) but a big readability win.
  const elevationAt = (x: number, y: number, z: number): number => {
    // Domain warp: nudge the lookup by a slow, smooth offset field.
    const wf = NOISE_FREQ * 0.6
    const wx = x + WARP * noiseWarp(x * wf + 11.3, y * wf, z * wf)
    const wy = y + WARP * noiseWarp(x * wf, y * wf + 7.1, z * wf)
    const wz = z + WARP * noiseWarp(x * wf, y * wf, z * wf + 3.7)
    const n = fbm(wx, wy, wz) // [-1,1]
    // Ridge-ish continental shaping: push mid values toward land, keep valleys low.
    const shaped = Math.sign(n) * Math.pow(Math.abs(n), 0.85)
    let e = shaped * RELIEF * radius
    // Region terrain identity: raise/lower mean land height per biome region
    // (desert flat, alpine/volcano tall, ocean sunk below sea level), feathered
    // at borders. Folded into elevationAt so heightAt()/placement match the mesh.
    if (regions) e += regionInfluenceAt(regions, x, y, z).bias * RELIEF * radius
    return e
  }

  // Inland water mask in [0,1]: 1 where a river/lake should carve a shallow basin.
  // Driven by a thin "valley" band of the warp field intersected with low-to-mid
  // land so peaks stay dry and oceans aren't double-counted. Pure function of dir.
  const riverMask = (x: number, y: number, z: number, eNorm: number): number => {
    if (eNorm <= SHORE + 0.01 || eNorm > FOREST_TOP) return 0
    const rf = NOISE_FREQ * 1.1
    const v = noiseWarp(x * rf + 41.0, y * rf - 17.0, z * rf + 5.0)
    // Ridge where |v| is small → sinuous waterways. Widened threshold so rivers
    // read as broad blue channels (with tributaries) rather than hairlines.
    const channel = 1 - Math.min(1, Math.abs(v) / 0.16)
    if (channel <= 0) return 0
    // Fade rivers out as land climbs toward forest (they pool in lowlands).
    const lowland = clamp01((FOREST_TOP - eNorm) / (FOREST_TOP - SHORE))
    return channel * channel * lowland
  }

  // --- public heightAt: terrain height above base radius for a unit direction ---
  // Land sits at/above 0; ocean floor returns a small negative (clamped at -inset)
  // so surfacePoint() over water lands on the visible water shell, not the seabed.
  // (River basins are a thin cosmetic dip handled in the mesh only — heightAt
  //  stays a pure function of elevationAt so gameplay placement is unchanged.)
  const heightAt = (dir: THREE.Vector3): number => {
    if (FLAT_PLANET) return 0 // smooth sphere → fixed-altitude cruise
    const x = dir.x
    const y = dir.y
    const z = dir.z
    const e = elevationAt(x, y, z)
    if (e < SEA_LEVEL) return -WATER_INSET * radius
    return e
  }

  // --- public surfacePoint: world point on the surface (+ optional altitude) ----
  // Zero-allocation: writes into `out` when provided, otherwise into _spOut.
  // Callers that don't pass `out` must consume the result before the next call.
  const _spDir = new THREE.Vector3()
  const _spOut = new THREE.Vector3()
  const surfacePoint = (dir: THREE.Vector3, extra?: number, out?: THREE.Vector3): THREE.Vector3 => {
    _spDir.copy(dir).normalize()
    const r = radius + heightAt(_spDir) + (extra ?? 0)
    const target = out ?? _spOut
    target.set(_spDir.x * r, _spDir.y * r, _spDir.z * r)
    return target
  }

  // ── Build the displaced, vertex-colored land mesh ──────────────────────────
  // toNonIndexed() gives every triangle its own vertices → crisp flat-shaded
  // facets and per-face biome colors without seams.
  const geo = new THREE.IcosahedronGeometry(radius, GEO_DETAIL).toNonIndexed()
  const pos = geo.attributes.position as THREE.BufferAttribute
  const vCount = pos.count
  const colors = new Float32Array(vCount * 3)

  // Reusable scratch — no allocation inside the vertex loop.
  const dir = new THREE.Vector3()
  const col = new THREE.Color()
  const tmp = new THREE.Color()

  // Track elevation range to normalize biome banding to the actual relief.
  // First pass: displace + record signed elevation per vertex.
  const elevWorld = new Float32Array(vCount)
  let eMin = Infinity
  let eMax = -Infinity
  for (let i = 0; i < vCount; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize()
    const e = elevationAt(dir.x, dir.y, dir.z) // signed world units
    if (e < eMin) eMin = e
    if (e > eMax) eMax = e
    elevWorld[i] = e
  }
  const eRange = eMax - eMin || 1

  for (let i = 0; i < vCount; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize()
    const eWorld = elevWorld[i]
    const e = (eWorld - eMin) / eRange // normalized 0..1

    // Inland water: carve a thin basin so rivers/lakes read as recessed water.
    const river = riverMask(dir.x, dir.y, dir.z, e)

    // Displace: ocean floor clamps to the water shell so the seabed never pokes
    // through the translucent water; land follows terrain. River basins dip a
    // hair below their surroundings (cosmetic only — heightAt() ignores this).
    let h = eWorld < SEA_LEVEL ? -WATER_INSET * radius : eWorld
    if (river > 0) h -= river * RELIEF * radius * 0.12
    const r = radius + (FLAT_PLANET ? 0 : h) // FLAT → undisplaced unit sphere
    pos.setXYZ(i, dir.x * r, dir.y * r, dir.z * r)

    // Latitude (|y| of the unit dir) frosts the poles regardless of altitude.
    const lat = Math.abs(dir.y)

    if (FLAT_PLANET) {
      // SKYDRIFT-MINIMAL: one uniform colour → a clean solid sphere.
      colors[i * 3] = FLAT_COLOR.r
      colors[i * 3 + 1] = FLAT_COLOR.g
      colors[i * 3 + 2] = FLAT_COLOR.b
    } else {
      // Pick + blend biome by band for soft pastel transitions.
      biomeColor(e, lat, river, col, tmp)

      // Region tint: push the surface colour toward this region's hue (feathered
      // at borders) so each biome region reads as a distinct PLACE from the air.
      if (regions) {
        const inf = regionInfluenceAt(regions, dir.x, dir.y, dir.z)
        const a = inf.amount
        col.r = col.r * (1 - a) + inf.tintR * a
        col.g = col.g * (1 - a) + inf.tintG * a
        col.b = col.b * (1 - a) + inf.tintB * a
      }

      // Subtle per-vertex value jitter for a hand-painted feel (deterministic).
      const j = 1 + (hash01(i) - 0.5) * 0.06
      colors[i * 3] = Math.min(1, col.r * j)
      colors[i * 3 + 1] = Math.min(1, col.g * j)
      colors[i * 3 + 2] = Math.min(1, col.b * j)
    }
  }

  pos.needsUpdate = true
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geo.computeVertexNormals()
  geo.computeBoundingSphere()

  const landMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: !FLAT_PLANET, // SKYDRIFT-MINIMAL: smooth-shade the flat sphere
    roughness: 1.0,
    metalness: 0.0,
  })
  const landMesh = new THREE.Mesh(geo, landMat)
  landMesh.name = 'planet-land'
  landMesh.castShadow = false
  landMesh.receiveShadow = false

  // ── Inner translucent water sphere (gentle bob animated by the water system) ─
  // Low-detail icosa: cheap, and flat-shaded facets catch the light like calm
  // pastel sea. Sits a hair below mean radius; land beaches rise above it.
  // We tint vertices a touch lighter where the seabed rises toward shore so the
  // ocean fades to a foamy turquoise at the coast instead of a hard blue ring.
  const waterRadius = radius - WATER_INSET * radius
  const waterGeo = new THREE.IcosahedronGeometry(waterRadius, 4)
  const wPos = waterGeo.attributes.position as THREE.BufferAttribute
  const wCount = wPos.count
  const wColors = new Float32Array(wCount * 3)
  const wDir = new THREE.Vector3()
  const wCol = new THREE.Color()
  const wTmp = new THREE.Color()
  for (let i = 0; i < wCount; i++) {
    wDir.set(wPos.getX(i), wPos.getY(i), wPos.getZ(i)).normalize()
    const e = elevationAt(wDir.x, wDir.y, wDir.z)
    // Depth proxy: how far the seabed sits below sea level (0 = at coast).
    const depth = clamp01(-e / (RELIEF * radius * 0.5))
    // Lerp deep blue → shallow → pale foamy shoal as we approach the shore.
    if (depth > 0.45) {
      wCol.copy(BIOME.waterDeep).lerp(wTmp.copy(BIOME.waterShallow), clamp01((1 - depth) / 0.55))
    } else {
      const t = clamp01((0.45 - depth) / 0.45)
      wCol.copy(BIOME.waterShallow).lerp(wTmp.copy(BIOME.shoal), t)
    }
    wColors[i * 3] = wCol.r
    wColors[i * 3 + 1] = wCol.g
    wColors[i * 3 + 2] = wCol.b
  }
  waterGeo.setAttribute('color', new THREE.BufferAttribute(wColors, 3))
  // Cache base positions so the bob is a pure function of base (no drift).
  const waterBase = new Float32Array(wPos.array.length)
  waterBase.set(wPos.array as Float32Array)
  const waterMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    roughness: 0.28,
    metalness: 0.0,
    flatShading: true,
    envMapIntensity: 0.6,
  })
  const waterMesh = new THREE.Mesh(waterGeo, waterMat)
  waterMesh.name = 'planet-water'
  waterMesh.renderOrder = 1 // draw after land so blending reads correctly

  // Group both; cast as Mesh to satisfy the Planet contract (mesh: THREE.Mesh).
  // Group is fine here — main() only ever adds ctx.planet.mesh to the scene.
  const group = new THREE.Group()
  group.name = 'planet'
  group.add(landMesh)
  if (!FLAT_PLANET) group.add(waterMesh) // SKYDRIFT-MINIMAL: no water shell when flat

  const planet: Planet = {
    radius,
    scale: radius / AUTHORED_RADIUS, // multiply authored (radius-100) lengths by this
    relief: RELIEF * radius, // max terrain displacement above base radius (world units)
    mesh: group as unknown as THREE.Mesh,
    heightAt,
    surfacePoint,
  }
  return planet
}

// ── Biome color lookup: writes the blended color into `out` ────────────────────
// `scratch` is a caller-provided Color used for lerping (no allocation).
//   e     — normalized elevation 0..1
//   lat   — |y| of the unit direction 0..1 (poles → 1) for latitude frosting
//   river — inland-water mask 0..1; >0 overrides land with freshwater
function biomeColor(
  e: number,
  lat: number,
  river: number,
  out: THREE.Color,
  scratch: THREE.Color,
): void {
  if (e < SHORE) {
    // Underwater floor: deep→shallow gradient toward the shoreline.
    const t = clamp01(e / SHORE)
    out.copy(BIOME.waterDeep).lerp(scratch.copy(BIOME.waterShallow), t)
    return
  } else if (e < SAND_TOP) {
    // Beach: damp sand at the waterline → dry sand inland for a real shoreline.
    const t = clamp01((e - SHORE) / (SAND_TOP - SHORE))
    out.copy(BIOME.sandWet).lerp(scratch.copy(BIOME.sand), smooth(t))
  } else if (e < GRASS_TOP) {
    // Lowland grass: brighter meadow near the beach → richer grass uphill.
    const t = clamp01((e - SAND_TOP) / (GRASS_TOP - SAND_TOP))
    // Quick sand→meadow fade in the first sliver so beaches melt into green.
    if (t < 0.18) {
      out.copy(BIOME.sand).lerp(scratch.copy(BIOME.meadow), smooth(t / 0.18))
    } else {
      out.copy(BIOME.meadow).lerp(scratch.copy(BIOME.grass), smooth((t - 0.18) / 0.82))
    }
  } else if (e < FOREST_TOP) {
    const t = clamp01((e - GRASS_TOP) / (FOREST_TOP - GRASS_TOP))
    out.copy(BIOME.grass).lerp(scratch.copy(BIOME.forest), smooth(t))
  } else if (e < ROCK_TOP) {
    // Forest→rock, with darker rock on the upper crags.
    const t = clamp01((e - FOREST_TOP) / (ROCK_TOP - FOREST_TOP))
    out.copy(BIOME.forest).lerp(scratch.copy(BIOME.rock), smooth(t))
    if (t > 0.5) out.lerp(scratch.copy(BIOME.rockDark), smooth((t - 0.5) / 0.5) * 0.5)
  } else {
    const t = clamp01((e - ROCK_TOP) / (1 - ROCK_TOP))
    out.copy(BIOME.rock).lerp(scratch.copy(BIOME.snow), smooth(t))
  }

  // Latitude frosting: dust snow onto land near the poles, strongest on high
  // ground. Lat starts mattering past ~0.78 so equatorial coasts stay green.
  if (e >= SAND_TOP) {
    const polar = clamp01((lat - 0.78) / 0.22)
    if (polar > 0) {
      const altBoost = clamp01((e - SAND_TOP) / (1 - SAND_TOP))
      const snowAmt = clamp01(polar * (0.35 + 0.65 * altBoost))
      out.lerp(scratch.copy(BIOME.snow), smooth(snowAmt))
    }
  }

  // Inland freshwater: carved rivers/lakes paint over land as bright blue.
  // Boost the mask before smoothing so strong-mask vertices lerp to (near-)full
  // river colour — the channel core reads as solid water, banks fade to land.
  if (river > 0) {
    out.lerp(scratch.copy(BIOME.river), smooth(clamp01(river * 1.6)))
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// Smoothstep — softens linear lerp params into gentle pastel transitions.
function smooth(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

// Cheap deterministic hash → [0,1) for per-vertex jitter (no allocation).
function hash01(i: number): number {
  let x = (i + 1) * 374761393
  x = (x ^ (x >>> 13)) * 1274126177
  x = x ^ (x >>> 16)
  return (x >>> 0) / 4294967296
}

// ─────────────────────────────────────────────────────────────────────────────
// Water bob system — gently undulates the inner water sphere's vertices.
// Pure function of base position + elapsed time → no drift, no per-frame alloc.
// Three interfering swell bands + a fast high-freq shimmer give a soft, lively
// sea that never tiles. Amplitude is tiny so it reads as a calm breathing ocean.
// ─────────────────────────────────────────────────────────────────────────────
export function createPlanetWaterSystem(planet: Planet): GameSystem {
  // Reusable temps captured at module/closure scope — zero allocation in update().
  let water: THREE.Mesh | null = null
  let basePos: Float32Array | null = null
  let attr: THREE.BufferAttribute | null = null
  let baseRadius = planet.radius

  // Bob tuning — small amplitude so it reads as a calm, breathing sea.
  const AMP = planet.radius * 0.0017
  const SHIMMER = planet.radius * 0.0006 // tiny fast ripple layered on the swell
  const SPATIAL = 7.0 // wave count around the sphere
  const TIME_FREQ = 0.6 // wave speed
  const UPDATE_HZ = 30 // throttle vertex writes (plenty smooth, kinder to mobile)
  let accum = 0

  return {
    name: 'planet-water',
    init(_ctx: GameContext): void {
      const group = planet.mesh as unknown as THREE.Object3D
      const found = group.getObjectByName?.('planet-water') as THREE.Mesh | undefined
      if (!found) return
      water = found
      attr = water.geometry.attributes.position as THREE.BufferAttribute
      const src = attr.array as Float32Array
      basePos = new Float32Array(src.length)
      basePos.set(src)
      baseRadius = planet.radius - WATER_INSET * planet.radius
    },
    update(dt: number, ctx: GameContext): void {
      if (!water || !basePos || !attr) return
      // Throttle: accumulate dt, only rewrite vertices a few times/sec.
      accum += dt
      if (accum < 1 / UPDATE_HZ) return
      accum = 0

      const t = ctx.elapsed() * TIME_FREQ
      const arr = attr.array as Float32Array
      const n = basePos.length
      // Interfering sine bands along the sphere give a soft, non-tiling swell,
      // with a faster, higher-frequency shimmer on top for sparkle.
      for (let i = 0; i < n; i += 3) {
        const bx = basePos[i]
        const by = basePos[i + 1]
        const bz = basePos[i + 2]
        // Unit dir (base sphere is exactly baseRadius, so /baseRadius == normalize)
        const ux = bx / baseRadius
        const uy = by / baseRadius
        const uz = bz / baseRadius
        const swell =
          Math.sin(ux * SPATIAL + t) * 0.5 +
          Math.sin((uy + uz) * SPATIAL * 0.75 - t * 1.3) * 0.5
        const shimmer =
          Math.sin((ux + uy) * SPATIAL * 2.7 + t * 2.4) *
          Math.sin((uz - ux) * SPATIAL * 2.3 - t * 1.9)
        const r = baseRadius + swell * AMP + shimmer * SHIMMER
        arr[i] = ux * r
        arr[i + 1] = uy * r
        arr[i + 2] = uz * r
      }
      attr.needsUpdate = true
      // Normals left as-is: amplitude is tiny and recomputing per-frame is costly.
    },
    dispose(): void {
      water = null
      basePos = null
      attr = null
    },
  }
}
